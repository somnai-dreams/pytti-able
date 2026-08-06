# STUDIO Create Mode — UX + Architecture Spec

**Status: binding.** This document governs the Create-mode build. Where it is silent,
the kit doctrine (`kit/README.md`, vendored — see §2.3) and
`vibescript/docs/engineering.md` govern. Where those are silent, ask the lead.

Ground truth for the server API is `/tmp/studio-api-inventory.md` (spot-checked
against `app/server.py` @ branch `core-v2` on 2026-07-31; all load-bearing claims in
this spec were re-verified against source — line references below are to
`app/server.py` as of commit `bb6bb5e`).

Non-negotiables inherited from the lead:

- Create = new `index.html` + `app/static/create.js`, a bun-built bundle from
  TypeScript in `app/web/`. **No framework. No React.** The chassis composition in
  `kit/examples/chassis-notes/index.ts` is the architectural template.
- The existing bench moves **verbatim** to `bench.html` (same `app.js`, same
  `style.css`, zero behavior change) and stays fully functional.
- Max's running STUDIO on port **7860 is never touched**. All dev/verification runs
  its own server instance via `PYTTI_STUDIO_PORT` (use 7911).
- Fail loud. Parse & validate at boundaries. No silent catches, no defensive `?.`
  chains, no fallback-that-hides-bugs.

---

## 1. Surfaces and files

### 1.1 File moves and additions

| path | action |
|---|---|
| `app/static/index.html` | **move verbatim** to `app/static/bench.html` (`git mv`, no edits except the one boot addition in §1.2). The server's static fallback (`server.py` ~line 1344) already serves any file under `static/`, so `/bench.html` works with zero server change. Its relative references (`app.js`, `style.css`) stay intact. |
| `app/static/index.html` | **new** — the Create shell (static ids, `<script type="module" src="create.js">`, `create.css`). Served at `/` by the existing route (`server.py` line 1340). |
| `app/static/create.css` | new — Create's stylesheet. `style.css` is bench-only and untouched. |
| `app/static/create.js` | build artifact — never hand-edited. Committed (the repo has no CI build). |
| `app/web/` | new — TypeScript sources (§3). |
| `app/static/app.js` | one addition only: the deep-link boot snippet (§1.2). Everything else byte-identical. |

Title for the new `index.html`: `PYTTI STUDIO`. `bench.html` keeps its title as-is.

### 1.2 Bench deep link (the minimal hash-param addition)

The bench has **no** existing deep-link mechanism (verified: no `location`/`hash`
reads in `app.js`). Selection state is `state.sel.sessionId`, with `null` meaning
"follow live", and selecting the live session normalizes to `null`
(`app.js` line 1588). The addition mirrors that exactly.

In `app.js` `boot()`, immediately after `state.sessions = { byId, order }` and the
live-adoption block:

```js
// deep link: /bench.html#s=<id> stages that session (Create's "Advanced" handoff).
// Read once at boot; no hashchange listener — a handoff always loads a fresh document.
const dl = /^#s=([A-Za-z0-9_-]+)$/.exec(location.hash)
if (dl != null && byId[dl[1]] != null) {
  state.sel.sessionId = dl[1] === state.live.sessionId ? null : dl[1]
}
```

Unknown or malformed ids are ignored (the bench boots normally — a stale link must
not brick the page; this is a URL boundary, the one place lenient parsing is
correct). No other `app.js` change is permitted.

### 1.3 Build pipeline

- `app/web/package.json` — bun scripts, no runtime deps:
  - `"build": "bun build create/dom/main.ts --outfile ../static/create.js --minify"`
  - `"check": "bunx tsc --noEmit && bun test"`
- `app/web/tsconfig.json` — the strict set from `engineering.md`, verbatim:
  `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noImplicitOverride`,
  `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`,
  `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`.
- Bundle budget: `create.js` ≤ 100 KB minified (chassis-notes is 13 KB; masonry +
  reel-strip + app code lands well under). No external font/JS CDN dependency for
  logic — the Google-Fonts stylesheet link is the only remote reference, same as
  bench.

---

## 2. Server prerequisites

### 2.1 S1 (REQUIRED) — summary gains `scenes`, `width`, `height`

The gallery must be a single `GET /api/sessions`: it needs prompt text and the
frame aspect ratio **before** any thumb loads (masonry heights come from data, not
image `onload` measurement). Neither is in `SessionSummary` today (verified,
`SessionStore.summary`, `server.py` line 543).

In `SessionStore.summary`, after the collapsed-state block:

```python
cfg = s.get("config") or {}
out["scenes"] = cfg.get("scenes")
out["width"] = cfg.get("width")
out["height"] = cfg.get("height")
```

All three are `null` for a session with no snapshot (imported legacy sessions may
lack fields) — the client parser handles `null` explicitly (§4.2).

### 2.2 S2 (RECOMMENDED) — thumbs to 384 px

`_get_session_subresource` generates thumbs at 192 px (`im.thumbnail((192, 192))`,
line 1395). At 2× DPR a ~280 px masonry column renders that soft. Change both
tuple values to `384` and delete existing `outputs/*/thumbs/` directories once
(they regenerate lazily). Thumb URLs are immutable-cached, so stale 192s would
otherwise persist per-browser; the one-time delete avoids a mixed gallery.

Explicitly out of scope: archive/soft-hide, prompt in SSE payloads.
(Changed 2026-08-06: the original "PUT→POST pair is the design" ruling is
superseded by S4 — the self-contained POST replaced it after the shared-draft
contamination incident. See §2.4 and §5.6.)

### 2.3 Kit vendoring

Copy these modules **verbatim** from the staged kit (`/tmp/kit-vendor/kit`,
mj-gallery `systems-library` @ `e3f96e3174`) into `app/web/kit/`:

```
kit/midui/      (num.ts, motion.ts, dom.ts)
kit/onestore/   (core.ts, dom.ts)
kit/env/        (core.ts, dom.ts)
kit/toplayer/   (core.ts, feel.ts)
kit/masonry/    (core.ts, feel.ts)
kit/reel-strip/ (core.ts, feel.ts)
```

Plus each module's `core.test.ts` (they run under `bun test` — the kit's own
checked surface travels with it). Record the pin in `app/web/kit/KIT_COMMIT`
(`e3f96e3174`). `interaction/`, `virtual-grid/`, `versioned-store/`,
`history-tree/`, `chip-query/` are not needed — do not vendor them. Kit files are
never edited; product policy that differs from `mjFeel` lives in
`create/core/feel.ts` (§3), never patched into kit `feel.ts`.

### 2.4 S4 (REQUIRED, added 2026-08-06) — self-contained `POST /api/sessions`

`POST /api/sessions` dispatches on the presence of a `values` key in its JSON
body (`server.py` `_post_sessions`):

| body | path |
|---|---|
| absent, `{}`, or `{mode}` only | **draft-based** — reads `config/draft.yaml` via `read_draft()`. Byte-identical to the pre-S4 behavior; this is the bench's path and the bench is unchanged. |
| contains `values` | **self-contained** — the request carries everything; the shared draft is **never read or written**. |

Self-contained body contract:

```
{ mode?: 'now' | 'queue' | 'preempt',   // default 'now'; Create always sends 'queue'
  values: { <config schema fields> },   // coerce_values() — unknown/mistyped field -> 400
  forkOf?: string | null,               // lineage; becomes forkedFrom on the session
  seedLocked?: boolean }                // default false; false -> server rolls the seed
```

Server-side composition (`compose_submission()`): `tuned_defaults()` — schema
defaults + `config/default.yaml` curation, the same base a fresh draft starts
from — with `coerce_values(body.values)` applied on top. Then the **same**
`preflight` + mode dispatch as the draft path. 400 on: an unknown envelope key,
non-object `values`, mistyped `forkOf`/`seedLocked`, any unknown or mistyped
config field, preflight errors, or a full queue (§2.5). Responses:

| status | body | when |
|---|---|---|
| `201` | `{sessionId, seed}` | started immediately (`now` idle, `queue` idle+empty queue, `preempt` idle) |
| `202` | `{queuedId, position}` | `queue`, busy — APPENDED to the FIFO; `position` is 1-based |
| `202` | `{preempting, queuedId, position: 1}` | `preempt`, busy — live render stopped, preemptor parked at the head |
| `400` | `{error, issues?}` | coercion, preflight, or queue-cap failure |
| `409` | `{error, live}` | `now`, busy — unchanged |

(The pre-queue-rework `202 {queued, replaced}` shape — and the whole silent-replace
contract behind it — is dead. There is no `replaced` field anywhere.)

Covered by `app/test_server.py` (in-process handler tests, stdlib unittest —
`.venv/bin/python app/test_server.py`): defaults+values composition, draft
byte/mtime-untouched on the self-contained path, unknown-field 400s, preflight
firing on both paths, the draft-based regression suite, and the §2.5 queue
suites (append/positions, cap, cancel renumber, auto-start on done AND failed,
preflight-fail-at-start robustness, cancel-vs-autostart, preempt-queue-intact,
draft-composed-at-enqueue immutability).

### 2.5 The render queue — a real FIFO (reworked 2026-08-06)

> "why do you replace my queued render instead of adding it to the queue, wtf is
> the point of a queue if it can only have one item lol" — the user directive
> that killed the one-slot queue.

`MANAGER.queue` is an ordered FIFO, **cap 20** (`QUEUE_CAP`). Over-cap `queue`
submissions get `400 {error}` naming the cap; nothing is ever evicted. Every
item stores its FULL composed submission at enqueue time — `{id, slug, values,
forkOf, seedLocked, enqueuedAt}` — self-contained per the §5.6 isolation
invariant: a bodyless (bench, draft-based) submission composes the draft **at
enqueue**, so later draft edits never mutate a queued item. Item ids are minted
at enqueue and become the session id at start.

Endpoints:

| method + path | behavior |
|---|---|
| `POST /api/sessions {mode:'queue'}` | idle + empty queue → starts (`201`); otherwise **APPENDS** (`202 {queuedId, position}`) — never replaces |
| `POST /api/sessions {mode:'preempt'}` | the EXPLICIT jump-the-line verb (bench-only): live render killed, preemptor parked at the **head**, existing queue intact behind it (`202 {preempting, queuedId, position: 1}`); idle → plain start (`201`). Bypasses the cap but holds exactly ONE slot: while the previous preemptor is still parked (the live render takes up to 5 s to die — SIGTERM grace), another preempt REPLACES it — N impatient clicks = one render, and the backlog never grows past cap+1 |
| `GET /api/queue` | `{items: [{id, position, slug, scenes, width, height, stepsPerScene, enqueuedAt}, …]}` — ordered, 1-based positions, enough per item to render a tile without another fetch |
| `DELETE /api/queue/{id}` | cancel ONE item → `204`, positions renumber; `404` if it already started or was cancelled. Never touches the running render |
| `DELETE /api/queue` | clear the whole queue (the bench's CLEAR QUEUE) → `204` |

Lifecycle: when the running render reaches ANY terminal state (done, failed, or
stopped/cancelled — preemption included), `_finalize` → `_start_next()` starts
the head under the item's pre-minted id. The head is **peeked, not popped**: it
stays in the queue — still cancellable, still counted by enqueue's idle check,
its id still taken for minting — until the spawn (or its failure record) commits
under the lock, so no window exists where an item lives outside both the queue
and the live slot. Head-of-line start is robust: the item is **re-preflighted at
start** (its init image may have vanished since enqueue) and a failure —
including an exception inside preflight or the failure-record write itself —
surfaces as a `failed` session (failExcerpt = the errors) while the next item
starts; nothing that happens to one item can wedge the drain. A manual start
winning the peek→commit window simply leaves the head queued for the next
`_finalize`. Every queue mutation (append, cancel, drain, preempt, clear)
publishes the full `{items}` list as the `queue` SSE event.

Thread-safety: all queue mutations, the busy check, the start-vs-append
decision, and the head's peek→commit spawn happen under `MANAGER._lock` in
single acquisitions (`_spawn_locked` exists so enqueue and `_start_next` can
spawn atomically with their checks) — no lost items, no double-starts, no
start-after-cancel, no FIFO jumps by latecomer submissions, no minted-id
collisions. `_publish_queue` snapshots AND publishes under the lock (callers
never hold it — non-reentrant), so racing mutations land their snapshots in
the SSE ring in snapshot order and a client replacing its mirror wholesale can
never see an older list after a newer one.

---

## 3. Module layout — `app/web/`

Kit rule 2 applies to app code too: **core** is pure TS (no DOM, no fetch, no
`Date.now`, no `Math.random`); **dom** owns every browser effect and reads
environment facts once. Core files never import dom files. String/JSON-domain core
files (parsers, reducers) are outside freerange's numeric subset — each says so in
its header and carries a colocated test file as its checked surface (kit rule 3).

```
app/web/
  package.json
  tsconfig.json
  kit/                      # vendored, verbatim (§2.3)
  create/
    core/
      feel.ts               # Create policy constants: gaps, card min width, spring k/b,
                            #   toast ms, starting-grace ms, strip metrics (adopts kit
                            #   mjFeel values where unchanged)
      presets.ts            # aspect/size/steps/look/seed tables; resolveDims;
                            #   composeSubmission; matchPresets (reverse map);
                            #   the §5.6 invariant whitelists              [+ .test.ts]
      api.ts                # THE parse boundary: parseSessionSummary, parseSessionDetail,
                            #   parseQueue, parseSseEvent (tagged union), parseStartResult,
                            #   parseErrorBody; url builders frameUrl/thumbUrl/artifactUrl
                            #   [string domain — worked tests]              [+ .test.ts]
      model.ts              # CreateState type (§4); event appliers: applyStateEvent,
                            #   applyProgressEvent, applyFrameEvent, applyQueueEvent,
                            #   applyEncodeEvent, reconcileSessions — each a pure
                            #   (state slice, event) -> new slice           [+ .test.ts]
      gallery.ts            # deriveGallery(state) -> GalleryEntry[]; makeMasonrySource;
                            #   entry key/size accessors                    [+ .test.ts]
      lightbox.ts           # makeFramesSource(tile) + makeJobsSource(tiles); two-axis
                            #   scrub transitions (pin/follow + dominant-axis rules);
                            #   openAnchor geometry inputs                  [+ .test.ts]
      keys.ts               # KeyFacts -> Intent union (exhaustive)         [+ .test.ts]
      surfaces.ts           # Z-ladder consts; surfaces(state) -> Surface<CreateView>[];
                            #   topmostDismissable(state)                   [+ .test.ts]
    dom/
      main.ts               # boot; the single state object instance; rafRenderLoop;
                            #   createWakeLoop (toast expiry + starting-grace deadlines);
                            #   watchEnv; event listener registration; render dispatch
      net.ts                # fetch wrappers (parse through core/api, throw on violation);
                            #   EventSource lifecycle + reconnect resync (§6.3)
      renderBar.ts          # prompt bar + settings popover projection
      renderGallery.ts      # masonry walk -> absolutely-positioned tile nodes
                            #   (JIT node map, mark-and-sweep eviction)
      renderLightbox.ts     # stage double-buffer, jobs + frames reels, actions row
      renderTop.ts          # toplayer root: orderSurfaces -> confirm / toast render
```

Rules of the split, applied:

- **Freerange core** (pure, testable without a browser): the preset tables and
  submission composition, the reverse preset match, tile/state derivations, every
  SSE-event → state transition, masonry source construction, reel source + scrub
  rules, keyboard intent mapping, surface list + Z-ladder.
- **Dom**: `fetch`, `EventSource`, `performance.now`, `Math.random` (the one
  client-side seed roll, §5.4), all DOM reads/writes, spring stepping, scroll and
  key listeners, `window.open`.
- Env facts enter core as the `Env` snapshot (kit/env), read once in `main.ts`,
  re-read only by `watchEnv`'s listener set.
- §15.3 adds `core/init.ts`, `core/mask.ts` (+ tests) and `dom/renderMask.ts`
  for the image-input feature.

---

## 4. The single state object

One plain object in `dom/main.ts`, typed by `core/model.ts`. Events mutate it and
call `scheduleRender()`; the prompt input's `input` handler calls `renderNow()`
(the controlled-input rule). Springs, DOM node caches, per-frame pointer scratch
live **beside** the store, not in it (precedent: bench `anim`/`domCache`; chassis
example).

```ts
// core/model.ts
type SessionState = 'rendering' | 'stopped' | 'done' | 'failed' | 'imported'
type Substate = 'launching' | 'loading_models' | 'rendering' | 'stopping'

type Artifact = { name: string; bytes: number; fps: number | null; format: 'mp4' | 'prores' }

type LiveTelemetry = {
  substate: Substate
  step: number; stepsTotal: number
  scene: number; sceneCount: number
  phase: 'pre_animation' | 'interpolation' | 'scene'
  sPerStep: number; etaSec: number
}

type Tile = {
  id: string
  slug: string
  scenes: string | null          // S1; null only for legacy imports without a snapshot
  state: SessionState
  seed: number | null
  startedAt: number
  endedAt: number | null
  frames: number                 // 1-based frame indices are 1..frames
  stepsDone: number; stepsTotal: number
  sizeX: number; sizeY: number   // S1 width/height; legacy-null parses to 512x512 with
                                 //   legacyDims:true so masonry never sees a hole
  legacyDims: boolean
  forkedFrom: string | null
  imported: boolean
  artifacts: Artifact[]
  failExcerpt: string | null
  live: LiveTelemetry | null     // non-null iff state === 'rendering'
  detail: Record<string, unknown> | null  // full immutable config snapshot, fetched
                                          //   lazily on first lightbox open; cached
                                          //   forever (snapshots are immutable)
}

// Pending covers ONLY Create's own optimistic submission lifecycle: the in-flight POST
// and the enqueue->launching handoff gap. QUEUED tiles are NOT pending — they derive
// from `queue`, the server-truth FIFO mirror, directly (one representation per fact).
type Pending =
  | { kind: 'posting'; prompt: string; sizeX: number; sizeY: number }
  | { kind: 'starting'; id: string; prompt: string; sizeX: number; sizeY: number;
      deadline: number }  // wake-loop drops it if no SSE 'state' arrives by deadline

// One queued render as the server sends it (§2.5): enough to render a tile. position is
// 1-based, server-sent, and index-verified at the parse boundary.
type QueueItem = { id: string; position: number; prompt: string; sizeX: number; sizeY: number }

type AspectId = '1:1' | '3:4' | '4:3' | '16:9'
type ComposerAspect = AspectId | 'auto'      // 'auto' = the attachment's own AR (§5.1a);
                                             //   kept apart from AspectId so the dims
                                             //   Records stay exhaustively table-keyed
type SizeId = 'draft' | 'full'
type LookId = 'limited' | 'unlimited' | 'vqgan'
type SeedMode = { kind: 'random' } | { kind: 'locked'; seed: number }

type Composer = {
  prompt: string
  // null = "inherit tweak base" — reachable ONLY while tweak != null (a fresh
  // composer always has concrete ids). Renders as a CUSTOM chip in the popover.
  // 'auto' is reachable ONLY while init != null (§5.1a) — clearing the attachment
  // reverts it to '1:1' in the same transition (core replaceInit).
  aspect: ComposerAspect | null
  size: SizeId | null
  // steps_per_scene verbatim (§5.1) — a plain validated positive integer, never
  // null: the chips are shortcuts that set it, the gear's custom input takes
  // 1..20000, and a tweak base rematerializes concretely (§5.3). Replaced the
  // StepsId literal union 2026-08-05 ("way more than 600 steps" + custom).
  steps: number
  look: LookId | null
  seedMode: SeedMode
  tweak: { of: string; baseValues: Record<string, unknown> } | null
  // The EXPERIMENTS panel (§5.7): six rows, each id-or-null; null = inherit tweak
  // base (CUSTOM chip), reachable only while tweak != null — the aspect convention.
  experiments: Experiments
  popoverOpen: boolean
  // The EXPERIMENTS disclosure's expanded/collapsed state — projection state like
  // popoverOpen: session-local, collapsed on load, persists across popover
  // open/close for the page's lifetime. NEVER part of the submission payload (§5.7).
  experimentsOpen: boolean
}

type LightboxSwipe = { direction: SwipeDirection; accumulated: number }

type Lightbox = {
  sessionId: string              // the OPEN JOB — the vertical axis's position
  frame: number | 'follow'       // 1-based; 'follow' tracks tile.frames live
  swipeX: LightboxSwipe          // frames axis (horizontal wheel) — reel-strip machine
  swipeY: LightboxSwipe          // jobs axis (vertical wheel) — reel-strip machine
                                 // dominant-axis rule (§8): at most ONE accumulator is
                                 // non-zero at a time
  anchor: { x: number; y: number; sizeX: number; sizeY: number }  // tile rect at open,
                                 // copied from the masonry cursor (never re-measured)
}

type CreateState = {
  boot: { phase: 'loading' } | { phase: 'ready' } | { phase: 'failed'; message: string }
  env: Env                                        // kit/env snapshot
  schemaFields: string[]                          // schema field-name whitelist (§5.2)
  tiles: Tile[]                                   // newest-first (server order preserved)
  pending: Pending | null
  queue: QueueItem[]                              // server-truth FIFO mirror, SSE-driven;
                                                  //   queued tiles derive from it
  composer: Composer
  lastRun: { values: Record<string, unknown>; forkOf: string | null;
             seedLocked: boolean } | null         // Cmd+Enter replays this verbatim
  lastSeed: number | null                         // most recent seed returned by POST;
                                                  //   seeds the locked toggle
  lightbox: Lightbox | null
  confirm: { kind: 'delete'; sessionId: string } | null
  toast: { text: string; expiresAt: number } | null
  download: { jobId: string; sessionId: string;
              framesDone: number; framesTotal: number } | null
  sse: { phase: 'connecting' | 'open' | 'retrying' }
  scrollTop: number                               // gallery scroller input (masonry viewport)
  anchorPin: { key: string; prevY: number } | null // masonry scroll-anchor pair
  now: number                                     // performance.now() at frame start
}
```

Data-modeling notes (binding):

- §15.3 adds `composer.init` (the image attachment) and `state.maskEditor`; the
  confirm union gains a `discard-mask` kind. Additive only — nothing above changes.
- `tiles` is a flat array, single source of truth. Lookups are linear scans
  (`findTile(tiles, id)` in core) — hundreds of sessions × ≤2 events/s is nothing;
  no `byId` map, no denormalized ordering.
- The newest thumb URL is **derived**: `thumbUrl(id, tile.frames)` — never stored.
  Same for the newest frame URL. (`/api/sessions/{id}/thumbs/{i}` is immutable per
  index; the index moving IS the invalidation.)
- No field mirrors another. `queue` mirrors the server FIFO and queued tiles derive
  from it directly; `pending` is Create's own submission lifecycle (posting/starting
  only); they reference each other by id only.
- Tile identity keys everything (DOM node map, springs, anchor pin) — never
  view-tree position.

---

## 5. Preset tables (`core/presets.ts`)

### 5.1 The tables — exact values, exhaustive

(Changed 2026-08-06: the QUALITY preset — which bundled the size class with the
step count — is retired, decoupled into the two first-class controls below. The
dims values are unchanged; `standard`'s pair became the defaults.)

Size picks the size class, steps is `steps_per_scene` verbatim, aspect picks the
shape within the class. `resolveDims(aspect, size)` is a pure table lookup:

| aspect | `draft` (256-class) | `full` (512-class) |
|---|---|---|
| `1:1`  | 256 × 256 | 512 × 512 |
| `3:4`  | 224 × 288 | 448 × 576 |
| `4:3`  | 288 × 224 | 576 × 448 |
| `16:9` | 320 × 180 | 640 × 360 |

| size | class |
|---|---|
| `draft` | 256 |
| `full` | 512 |

**STEPS** is a plain validated number (reworked 2026-08-05 — "i need an option
for way more than 600 steps. let me also add a custom amount if i want"), still
`steps_per_scene` **verbatim** in the payload and displayed as the actual
numbers, no euphemism labels. The preset chips are `150 · 200 · 300 · 600 ·
1200 · 2400` (450 retired) — **shortcuts** that set `composer.steps`, not a
closed set. Next to them sits the **CUSTOM input** (`#steps-custom`): a positive
integer `1..20000` (`MAX_CUSTOM_STEPS`), parsed at the boundary by
`parseCustomSteps` (invalid text is recoverable data — the input marks itself
`invalid`, the composer keeps its last valid number, and the projection re-syncs
the text on blur). A `composer.steps` value matching a chip highlights that
chip (input empty); any other value shows in the input, highlighted as the
selection. The original directive stands: "i desperately need to be able to
control the step count from the settings dropdown, its the biggest lever."
The detail-recovery battery (2026-08-06, `/tmp/pytti-eval/detail-recovery/report.md`)
established steps as the dominant detail lever — 300 beat 200 at 7W/1L on the
calibrated judge. The user controls the count now; nothing in Create adjusts it
behind the gear.

| look | `image_model` value |
|---|---|
| `limited` | `Limited Palette` |
| `unlimited` | `Unlimited Palette` |
| `vqgan` | `VQGAN` |

Popover display labels: `1:1 · 3:4 · 4:3 · 16:9 · AUTO`; `DRAFT · FULL`;
`150 · 200 · 300 · 600 · 1200 · 2400 · [custom]`; `LIMITED · UNLIMITED · VQGAN`;
`SEED ⚄ RANDOM / 🔒 <n>`. Below the rows sits the collapsed `▸ EXPERIMENTS`
disclosure (§5.7).

Fresh composer defaults: `1:1`, `full`, `200`, `limited`, random seed — exactly
what the retired `standard` quality resolved to (512-class dims, 200 steps), so
a user who never opens the gear submits the identical payload.

### 5.1a The AUTO aspect (added 2026-08-05)

The ASPECT row gains an `AUTO` chip: size the canvas to the **attachment's own
aspect ratio** (the mask is painted over the init image at its dims, so a
mask-fitting canvas is an attachment-fitting canvas). It is an aspect **value**
(`Composer.aspect: AspectId | 'auto' | null`) — SIZE still picks the pixel-area
budget, and the §5.6 invariant is untouched: width/height remain determined by
visible controls (the chip + the visible attachment chip).

**Enablement.** The chip is selectable **iff** the attachment's natural pixel
dims are known (`core/init.ts initNaturalDims(init) != null`); otherwise it is
`disabled` with a title, the MASK chip's locked-surface treatment (§15.4). Dims
are known for a fresh attachment as soon as it is `ready` (§15.4 reads them
before the handoff); a rematerialized attachment loads them async (§15.8) —
until they land (or forever, for an unreadable/404 image) AUTO simply stays
disabled. No spinner machinery.

**Removal reverts, loudly.** `aspect === 'auto'` is reachable only while an
attachment exists. Clearing the attachment (chip ✕, bar clear, upload failure)
while AUTO is selected reverts the aspect to `1:1` in the same state transition
(core `replaceInit`, model-tested) — the chip selection visibly moves; a
dangling silent AUTO cannot exist. **Replacing** the attachment keeps AUTO: it
re-derives from the new image's dims once they are known (submits in the gap
are covered by the A1 uploading guard plus an `image size unknown — pick an
aspect` toast guard).

**Dims rule** (`core/presets.ts autoDims(natural, sizeClass, multiple)`): fit
the attachment's AR into the SIZE class's pixel-area budget, preserving AR,
each dim rounded to the engine-safe multiple:

```
budget = class²   (65 536 draft / 262 144 full — the §5.1 tables are
                   roughly equal-area; the 1:1 pair is reproduced exactly)
idealW = √(budget · arW/arH);  idealH = budget / idealW
dim    = max(multiple, round(ideal / multiple) · multiple)
```

No artificial AR clamp; the floor is one multiple per dim — the smallest the
engine renders.

The rounding multiple follows the LOOK (**verified against pytti-core**, the
per-model dims contract):

| look | multiple | why (pytti-core) |
|---|---|---|
| `limited`, `unlimited` | **8** | `PixelImage`/`RGBImage` parameter tensors are exactly `height × width` (`pixel.py`, `rgb_image.py`) — no stride; 8 is chosen because the mp4 DOWNLOAD path (libx264 + `yuv420p`, no scale filter) requires **even** dims, and it matches `coarse_to_fine.stage_dims`' own non-final rounding granularity |
| `vqgan` | **16** | the engine silently **floors** each dim to the latent stride `f = 2^(num_resolutions−1)` (`vqgan.py` 184–192) — 16 for every model Create reaches (default `sflickr`; all taming ckpts are f16). Emitting multiples of 16 keeps declared dims == rendered dims (tile layout, thumbs, encode) |
| tweak CUSTOM look | base's `image_model` | pixel models → 8; VQGAN/LlamaGen (ds16 f=16, ds8 f=8)/unknown → **16**, which every stride in the engine divides |

`coarse_to_fine` (the PYRAMID row's default on fresh non-HOLD submissions, §5.7)
imposes no back-constraint: its final stage runs the **exact** configured dims
and its non-final stages self-round to multiples of 8 with a 64 floor.

`composeSubmission` and `composerDims` resolve AUTO through the same helper
(the optimistic tile's AR always matches the session's); both **throw** when
AUTO is reached without known attachment dims — a caller-contract violation
(the chip's enablement plus the submit guard make it unreachable).

### 5.2 `composeSubmission(composer): { values, forkOf, seedLocked }`

(Renamed from `composeDraft` 2026-08-06 — same composition rules, new
destination: the payload goes straight into the self-contained
`POST /api/sessions` body (S4, §2.4). **Create never touches `/api/draft`.**
The server composes `values` over the same base a fresh draft starts from
(schema defaults + `config/default.yaml`), so sending only the overrides keeps
its exact meaning.)

- Fresh (tweak == null):
  `values = { scenes: prompt, width, height, steps_per_scene, image_model }`
  plus the §5.6 pins, plus the EXPERIMENTS rows' emissions (§5.7 — the untouched
  panel contributes exactly `coarse_to_fine: true, coarse_stages: 3`, the retired
  pin's bytes), plus `seed` iff `seedMode.kind === 'locked'`;
  `forkOf: null`; `seedLocked: seedMode.kind === 'locked'`.
- Tweak (tweak != null):
  `values = { ...tweak.baseValues, ...overrides, scenes: prompt }` where
  `overrides` includes width/height only for **non-null** aspect (their size
  class from `size` when non-null, else exact-matched from the base dims —
  miss → 512 class), `steps_per_scene` only for non-null steps (null inherits
  the base's `steps_per_scene` verbatim), `image_model` only for non-null look,
  and seed per seedMode. `forkOf: tweak.of`.
  The fork snapshot **is** the values set (already complete); no defaults-merge
  semantics are needed for it to replay faithfully.
- `tweak.baseValues` is built by `submittableValues(config, schemaFields)`: keep
  only keys present in the schema field whitelist (`Object.keys(schema.fields)`
  fetched at boot). This is parse-at-the-boundary: a snapshot key the server's
  coercion would 400 on (e.g. anything non-schema) never leaves the client.

### 5.3 `matchPresets(values): { aspect, size, look }` + `rematerializeSteps` (reverse map, for Tweak)

Exact-match only: `(width,height)` against the dims table → aspect **and** size
together (a pair in the 256 table is `draft`, in the 512 table `full`; a miss
leaves both `null` — never one without the other); `image_model` against the
look table → look. Any miss → `null` for that control (renders as `CUSTOM`,
inherits base on submit). No nearest-neighbor guessing.

**Steps is no longer preset-matched** (2026-08-05, decided with the
steps-as-plain-number rework): the base's `steps_per_scene` rematerializes
**concretely** via `rematerializeSteps(baseValues)` — verbatim when it is a
positive integer (275 shows as 275 in the custom input, `2400` highlights its
chip; a bench-authored 50000 rematerializes verbatim, uncapped — the 20000 cap
governs only what the input *accepts*), else the fresh default `200`
(`DEFAULT_STEPS`; reachable only for legacy imports without a usable snapshot).
The steps null-inherit state is **removed**: keeping it was only load-bearing
while the composer couldn't represent non-preset numbers, and dropping it does
not touch the composer-null contract for aspect/size/look (each control's null
stands on its own; nothing switches over them jointly). Consequence, deliberate:
`composeSubmission` now always emits `steps_per_scene` on a tweak — the
rematerialized number equals the base's, so an untouched tweak submits the same
count it always did, and the gear now *shows* it instead of hiding it behind
CUSTOM (§5.6: what the user sees is exactly what submits). No
nearest-neighbor doctrine survives at the chips: 275 never highlights 300 — it
sits in the custom input as itself.

**`matchPresets` never returns `'auto'`** (decided with §5.1a): whether a base's
dims equal the AUTO-computed dims for its attachment is **not cleanly decidable**
at rematerialization time — the snapshot carries no attachment pixel dims (they
load async, §15.8, and may never load). Per the exact-match doctrine that miss
rematerializes `CUSTOM`, which inherits the base dims **verbatim** on resubmit —
a byte-identical replay, strictly better than re-deriving. (A square
attachment's AUTO dims are exactly a table pair; that exact match rematerializes
as the equivalent table chip — same dims either way.) The chip does not
retro-flip to AUTO when the dims arrive later: no silent state changes.

**`matchExperiments(values)` (added 2026-08-06, §5.7)** — the EXPERIMENTS panel's
reverse map, same exact-match doctrine, per row:

- INIT NOISE: `init_spectrum` absent/`'white'` → WHITE; `'gray'` → GRAY (chroma is
  **ignored for white/gray** — the engine is documented chroma-inert there, so the
  match is exact, not a guess); `'pink'` + `init_spectrum_chroma: 'natural'` → PINK;
  `'pink'` + any other chroma, `'fractal'`, or junk → CUSTOM.
  `init_spectrum_falloff` is a bench knob, not part of the row's mapping — it rides
  a tweak base verbatim.
- PYRAMID: `coarse_to_fine` false/absent → OFF (any stages value alongside false is
  schema-rejected upstream); `true` + `coarse_stages` 2/3/4 → that chip; `true` +
  any other ladder (5, absent, junk) → CUSTOM.
- COHERENCE / PHASE SCHEDULE / AUTO-STOP: false/absent → OFF, `true` → ON, junk →
  CUSTOM.
- FULL VISION: `cutout_sampler` absent/`'smart'` → OFF (smart **is** what OFF
  means — the tuned default), `'full'` → ON, `'classic'`/`'batched'`/junk → CUSTOM.

CUSTOM (null) rows inherit the base verbatim on resubmit — byte-identical replay,
like aspect/size/look. Null is reachable only under tweak (§5.7).

### 5.4 Seed control

Two-state toggle. `random` → the draft omits `seed`, `seedLocked: false`, server
rolls fresh (verified, inventory §1.9). Toggling to `locked` pins, in priority
order: the tweak base's seed, else `state.lastSeed`, else a fresh `uint32` rolled
in the **dom** layer (the one `Math.random` in the app — core receives it as
data). The pinned value is displayed read-only next to the toggle. Re-pinning =
toggle random → locked again. Every POST response's `seed` updates
`state.lastSeed`.

### 5.5 Image input

§15.6 amends `composeSubmission`/`matchPresets` with the init-image fields
(`init_image`, `direct_init_weight`, `semantic_init_weight`, `perceptor_backend`),
emitted **only** when an image is attached.

### 5.6 The isolation invariant (added 2026-08-06, binding)

The lead's directive, verbatim:

> "There can be no hidden sticky state or anything like that for features I
> can't see on the UI. It needs to be completely separate from the advanced
> mode."

Context: the shared bench draft silently contaminated every Create render for
weeks (`smoothing_weight: 1` and friends overriding the tuned defaults) because
Create's submissions routed through `PUT /api/draft`. The fix is structural,
not procedural:

1. **Create never reads or writes the shared draft.** Every submission (A1
   fresh, A2 re-run-last, A3 re-run) is a self-contained
   `POST /api/sessions {mode:'queue', values, forkOf, seedLocked}` (S4, §2.4).
   The draft file is the **advanced surface's private working state** —
   invisible to Create in both directions.
2. **The submission payload is exactly reconstructible from what the user can
   see.** For a fresh submission, every key in `values` is either a **visible
   control** or a **documented pin** (tables below). For a tweak/re-run, the
   payload adds only the fork base's own snapshot keys — provenance the user
   summoned explicitly via TWEAK/RE-RUN on a visible session.
3. **Enforced by tests on both sides**: `presets.test.ts` walks the full
   composer-option product and fails on any `composeSubmission` key outside
   `VISIBLE_CONTROL_FIELDS ∪ PIN_FIELDS` (fresh) or that union plus the base
   snapshot (tweak) — a new emitted key cannot land undocumented. The steps
   axis of that product is no longer a closed set: it walks the six preset
   chips PLUS a non-preset custom value (275) and the input's extreme (20000),
   on both the fresh and tweak sides. `app/test_server.py` asserts the draft
   file is byte- and mtime-identical across a self-contained POST.

Visible controls (field → the control that determines it):

| field | control |
|---|---|
| `scenes` | the prompt bar |
| `width`, `height` | ASPECT × SIZE chips (§5.1 dims table; AUTO fits the **visible** attachment's AR into the SIZE budget, §5.1a) |
| `steps_per_scene` | STEPS chips + the CUSTOM input (the raw number, verbatim) |
| `image_model` | LOOK chips |
| `seed` | SEED toggle (the locked value is displayed next to it) |
| `init_image` | the attachment chip (thumb + name) |
| `direct_init_weight` | INIT strength chips + the chip's MASK state |
| `semantic_init_weight` | the HOLD toggle |
| `perceptor_backend` | the `torch engine` note shown while HOLD is on |
| `init_spectrum`, `init_spectrum_chroma` | EXPERIMENTS · INIT NOISE chips (§5.7; PINK pairs chroma `natural`) |
| `coarse_to_fine`, `coarse_stages` | EXPERIMENTS · PYRAMID row (§5.7 — the retired invisible pin, made visible 2026-08-06) |
| `coherence_weighting` | EXPERIMENTS · COHERENCE toggle |
| `cutout_sampler` | EXPERIMENTS · FULL VISION toggle |
| `phase_scheduling` | EXPERIMENTS · PHASE SCHEDULE toggle |
| `auto_stop` | EXPERIMENTS · AUTO-STOP toggle |

Documented pins (constant on every fresh submission; not user-varied — their
documentation is this table + the `PIN_FIELDS` comments in `core/presets.ts`).
Changed 2026-08-06: the `coarse_to_fine`/`coarse_stages` pyramid pin **converted to
the visible PYRAMID row** (§5.7) — strictly better under this section's rule; the
two stills pins below stay pins (Create is stills-only by construction):

| field | pinned value | why |
|---|---|---|
| `animation_mode` | `'off'` | Create is a stills surface by construction; the tuned defaults carry `2D` |
| `interpolation_steps` | `0` | no scene-0 prompt ramp (composition-forming window) |

### 5.7 The EXPERIMENTS panel (added 2026-08-06, binding)

The user's directive, verbatim:

> "I dont like how limited the current create view is. It should be simple, but
> its too simple. I should be able to opt into the experimental modes we're
> making... i basically want to never ever open the confusing and shitty advanced
> view, so i need access to the higher level experiment toggles in create."

A collapsed disclosure row at the **bottom** of the gear popover — `▸ EXPERIMENTS`,
a bare label button with a rotating chevron (the one new popover idiom; everything
inside reuses the `.pop-row`/`.chip` affordances verbatim). Expanded/collapsed
state lives in `composer.experimentsOpen`: projection state like `popoverOpen` —
session-local, collapsed on load, persists across popover open/close for the
page's lifetime, and **never part of the submission payload**.

The rows, curated by the eval batteries (each option maps to schema fields; every
default = the engine/tuned default):

| row | options (default first) | fields |
|---|---|---|
| INIT NOISE | WHITE · PINK · GRAY | `init_spectrum`; PINK also sets `init_spectrum_chroma: 'natural'` — the 2026-08-06 init-noise battery's both-judges winner. WHITE/GRAY emit the spectrum only (chroma is engine-inert for both; engine default `full`). PINK chip hint names the battery |
| PYRAMID | 3 · 2 · 4 · OFF | `coarse_to_fine` + `coarse_stages` — the retired invisible pin as a visible control. OFF = the engine default (emits nothing); 2/3/4 emit both keys |
| COHERENCE | OFF · ON | `coherence_weighting` |
| FULL VISION | OFF · ON | `cutout_sampler: 'full'` when ON; OFF emits **nothing** (never an explicit `'smart'`) |
| PHASE SCHEDULE | OFF · ON | `phase_scheduling` |
| AUTO-STOP | OFF · ON | `auto_stop` (ON chip hint: `may stop early — detector is miscalibrated for the modern ensemble`, per the 2026-08-03 cut-at-129/200 incident) |

**The payload rule (binding, enforced by `presets.test.ts`):** a row adds keys iff
its selection differs from what the server's defaults-compose already produces.
Five rows default to the composed default, so an untouched panel adds **zero**
keys. PYRAMID is the deliberate exception: its default (3) is Create's judged pin
over the engine default (off) made visible — it emits its two keys at every
non-OFF selection and OFF emits nothing. Net: the untouched panel's payload is
**byte-identical** to the pre-panel pin era.

**Pyramid × HOLD MEANING (the one row interaction):** the engine refuses
`coarse_to_fine` + semantic init. While HOLD is on, the PYRAMID row shows OFF and
is disabled (the AUTO-chip locked treatment: disabled + title). Flipping HOLD on
while the row is non-OFF **visibly forces it to OFF** in the same transition
(core `model.applyHoldMeaning` — loud, the AUTO-aspect revert precedent, §5.1a);
flipping HOLD off re-enables the row where it stands (OFF) — no silent restore.
Tweak rematerialization re-asserts the same rule after `deriveInitFromBase`.
`composeSubmission` **throws** on the pair (any non-OFF row, null included, with
HOLD on) rather than silently omitting — what the row shows is what submits.

**Tweak semantics:** concrete rows apply — delete the row's fields, then set the
selection's keys (the random-seed delete mechanism: an OFF/WHITE re-pick restores
the composed default); null (CUSTOM) rows leave the base verbatim, so off-menu
bench values (fractal, `coarse_stages: 5`, `cutout_sampler: 'classic'`,
`init_spectrum_falloff`, `auto_stop_window`…) survive an untouched tweak
byte-for-byte. Rematerialization is `matchExperiments` (§5.3).

**Deliberately NOT offered** (documented so nobody re-litigates from the UI side):

| knob | why not |
|---|---|
| BORDER (`border_mode`) | clamp won its battery 9W/0L — a settled default, not an experiment |
| ANNEAL (`structure_annealing` + knobs) | falsified: 0W/7L stacked — bench-only |
| fractal / mono / full pink-chroma variants | all lost the init-noise battery; PINK+natural is the one winner offered |

Accepted caveat: NOISE PINK/GRAY with LOOK VQGAN fails loud at render start (a
codebook draw has no spectrum to shape — engine-documented); the failure surfaces
as a `failed` tile with the engine's message. No cross-row guard is added for it.

---

## 6. Actions → endpoint sequences, and SSE → state

All request/response bodies pass through `core/api.ts` parsers. A parse failure
**throws** (boundary violation = bug, not a UX state). Expected, recoverable
failures (400 with `{error}`, 409, network refusal) are data → toast.

### 6.1 User actions

**A1 — Submit (Enter in the bar, or the bar's ▶ button).**
Guards: `boot.phase === 'ready'`, `prompt.trim() !== ''`.
1. `state.pending = { kind: 'posting', prompt, ...resolveDims(...) }` → the
   optimistic tile renders **this frame**, before any network.
2. `POST /api/sessions {mode: 'queue', ...composeSubmission(composer)}` — the
   **one** network call: a self-contained submission (S4, §2.4); the shared
   draft is untouched (§5.6). Create always uses `queue` (idle → starts
   immediately; busy → APPENDS to the FIFO, §2.5). **Never `preempt` from
   Create** — killing a live render is a bench verb.
   - `201 {sessionId, seed}` → `pending = { kind: 'starting', id: sessionId, …,
     deadline: now + feel.startingGraceMs }`; `lastSeed = seed`; set `lastRun`.
   - `202 {queuedId, position}` → `pending = null` and the item is pushed onto
     `state.queue` (unless the SSE echo already landed it) — the optimistic
     tile hands over to the queued tile with the 202's position; set `lastRun`.
   - `400 {error: "preflight failed", issues}` → toast the first
     `severity === 'error'` issue's `message` (prefixed by its `field`);
     `pending = null` — queued tiles stay (append semantics: a failed POST
     never touched the queue). A coercion or queue-cap 400 (plain `{error}`)
     toasts the same way.
3. Composer keeps its prompt (Midjourney grammar: the bar retains text). Tweak
   mode persists until the user clears the bar (which resets `tweak = null` and
   restores concrete preset ids) or submits — after a tweak submit, `tweak` stays
   (iterating on the same base), matching MJ remix.

**A2 — Cmd+Enter (re-run last), global.**
Guard: `lastRun != null` (else toast `nothing to re-run`). Replays `lastRun`
verbatim: optimistic tile → `POST /api/sessions {mode:'queue', ...lastRun}` with
the same result handling as A1 — the identical self-contained path. (A
random-seed lastRun rolls a new seed server-side — "re-run" means same settings,
not same pixels.)

**A3 — Re-run (lightbox action on session S): same settings, fresh seed.**
1. Ensure `tile.detail` (fetch `GET /api/sessions/{S}` if null; cache).
2. `values = submittableValues(detail.config, schemaFields)` — the fork
   snapshot is already a complete values set.
3. `POST /api/sessions {mode:'queue', values, forkOf: S, seedLocked: false}`
   (A1 result handling; draft-free). Lightbox stays open; the new tile appears
   in the gallery behind it.

**A4 — Tweak (lightbox action on session S): prefill bar + popover.**
1. Ensure `tile.detail` as in A3.
2. `composer.prompt = String(config.scenes)`; `composer.tweak = { of: S,
   baseValues: submittableValues(config) }`; `{aspect, size, steps, look} =
   matchPresets(config)` (nulls → CUSTOM chips); `seedMode = { kind: 'locked',
   seed: config.seed }` (deterministic iteration; lineage matches the bench's
   fork-locks-seed convention).
3. Close the lightbox, focus the bar, caret at end. Popover stays closed.

**A5 — Advanced.**
From the lightbox on S: `window.open('/bench.html#s=' + S)` (new tab — the
gallery's SSE view keeps running). From Create's corner link: plain
`/bench.html`, new tab.

**A6 — Download (lightbox action on session S).**
- If `tile.artifacts` has an `mp4` → programmatic `<a download>` click on
  `/api/sessions/S/artifacts/{name}` (newest mp4 by list order). Done.
- Else if `state.download != null` → toast `an encode is already running`.
- Else `POST /api/sessions/S/encode {}` (server defaults fps/format) →
  `201 {jobId}` → `state.download = { jobId, sessionId: S, framesDone: 0,
  framesTotal: 0 }`. Progress + completion arrive via SSE `encode` (§6.2).
  `400` (no frames) → toast.

**A7 — Delete (lightbox action, confirm required).**
Affordance disabled when `tile.state === 'rendering'` or
`download?.sessionId === S` (inventory §1.16: never delete mid-encode; live
delete would 409). Click → `confirm = { kind: 'delete', sessionId: S }`
(toplayer surface). Confirm → `DELETE /api/sessions/{S}` → 204 → remove tile,
close lightbox if it shows S, `confirm = null`. Note in the confirm copy for
`imported` tiles: "imported session — files stay on disk and reappear after a
server restart".

**A8 — Cancel ONE queued item (× on its tile).**
Optimistic local removal FIRST (`removeQueueItem`: splice + renumber) so the SSE
echo — published by the server DURING the DELETE — can never see the cancelled
item as a drained head and phantom a `starting` tile. Then
`DELETE /api/queue/{id}` → 204 (echo re-asserts the list). A 404 means the item
auto-started or was cancelled elsewhere: re-fetch `GET /api/queue`, toast
`no longer queued…`. Cancelling a queued item never touches the running render.

**A9 — Open lightbox.** Click a session tile with `frames >= 1` (0-frame tiles
ignore clicks — nothing to show). `lightbox = { sessionId, frame:
state === 'rendering' ? 'follow' : tile.frames, swipeX: still, swipeY: still,
anchor: <copied cursor rect> }`. The anchor rect is **copied from the masonry
cursor during the emit walk** (stored per-tile in the DOM node map at placement
time) — never measured from the DOM.

**A10 — Two-axis scrub.** Wheel over the lightbox drives one reel-strip swipe
machine per axis (§8), dominant axis only. HORIZONTAL wheel (and `←`/`→`) scrubs
frames within the open job; VERTICAL wheel (and `↑`/`↓`) pages between jobs —
sessions with `frames >= 1`, gallery order. Clicking a reel thumb jumps to that
frame / that job. Frame pin/follow rule: setting frame to `tile.frames` while
the session renders → `'follow'` (pin releases at the newest frame); any
backward step pins. Landing on a job (wheel, arrow, or jobs-reel click) always
lands on its LATEST frame — so a rendering job lands following.

**A11 — Popover.** Gear button toggles; outside-click and Esc close. Popover
edits mutate `composer` only — **no network on popover interaction** (nothing
leaves the client until submit; live estimates via `/api/preflight` are
deliberately not on the Create surface).

**A12 — `/`** focuses the bar (unless focus is already in an input). Esc with no
surface open blurs the bar.

**A13 — STOP the running render (◼ STOP on the rendering tile; added
2026-08-05, "lets make sure i can stop then whenever i want").**
`POST /api/sessions/{id}/stop` — the endpoint predates Create (the bench's
STOP; `server.py` MANAGER.stop): it SIGTERMs the render's process group (202
`{stopping}`, SIGKILL after a 5 s grace), `_finalize` lands the session in the
**existing** `'stopped'` terminal state — no new union member was needed; every
switch over `SessionState` already handles it — and `_start_next()` advances
the FIFO **exactly like natural completion**. A stopped session keeps
everything rendered so far: frames in the gallery (`◼ n frames` chip, §7.3),
TWEAK/RE-RUN from its intact config snapshot, DOWNLOAD/DELETE like any other
terminal session.

Client flow: guard `tile.state === 'rendering'` and not already `stopping`;
optimistically set `live.substate = 'stopping'` (the STOPPING chip lands this
frame; the server's SSE `stopping` event confirms and the terminal `stopped`
settles it); `postStop` → 202 done. 404 is expected-recoverable data (the
render reached a terminal state in the gap — the SSE event owns the tile):
toast `no longer rendering — it already finished`. **Confirm-free**: stopping
is cheap and non-destructive — it KEEPS the work, unlike the queued tile's ×
(A8), which discards; the two controls are visually distinct for exactly that
reason (◼ STOP pill, accent hover vs bare ×, danger hover).

Frames-on-stop caveat (accepted): frames save every `steps_per_frame`
(~20 steps); the engine has **no** signal-time save — `pytti.workhorse`'s only
interrupt handling is a `KeyboardInterrupt: pass` (verified 2026-08-05,
read-only), so a stop keeps the last SAVED frame and up to ~`steps_per_frame`
steps of optimization past it are lost. Not worth an engine feature; documented
here and in `test_server.py`.

### 6.2 SSE events → state mutations

One `EventSource('/api/events')` for the page's lifetime. Every payload goes
through `parseSseEvent` → a tagged union; the dom layer switches exhaustively and
delegates to `core/model.ts` appliers. `X` = `payload.sessionId`.

| event | mutation |
|---|---|
| `state` (substate: `launching`, `loading_models`, `rendering`, `stopping`) | Tile exists → `tile.state = 'rendering'`; `tile.live` created if null (zeros) and `live.substate` set. Tile missing → this is a session Create hasn't seen (queue promotion, another tab): `GET /api/sessions/{X}`, parse, insert by `startedAt` order; if `pending?.id === X` → `pending = null`. |
| `state` (terminal: `done` \| `stopped` \| `failed`) | `tile.state = payload.state`; `tile.live = null`; `tile.frames = summary.frames`; `tile.stepsDone = summary.steps`; `tile.seed = payload.seed`; `tile.endedAt = eventArrivalEpoch`. If `failed` → `GET /api/sessions/{X}` to pick up `failExcerpt` (not in the event). If `lightbox` shows X with `'follow'` → freeze `frame = summary.frames`. |
| `progress` | Update `tile.live` fields (`step, stepsTotal, scene, sceneCount, phase, sPerStep, etaSec`). Create `tile.live` if null (reconnect case — REST only said `rendering`). |
| `frame` | `tile.frames = payload.savedTotal`. Newest thumb/frame URLs are derived from `frames`, so the tile re-renders with the new index. Lightbox on X in `'follow'` → stage advances (double-buffer swap on image load, never blanks). |
| `queue` | `{items}` — the full ordered list on every queue mutation. **Q-rules** (`applyQueueEvent`): the server list replaces `state.queue` wholesale (queued tiles derive from it, so appends/renumbers/bench enqueues need no special handling). The ONE derived transition: the **old head** vanishing from the new list — with no session tile for its id yet and no `posting` in flight — bridges into `pending = { kind: 'starting', …, deadline: now + feel.startingGraceMs }`: the drain normally precedes `state: launching` (inventory gotcha 5) and must not flicker; the wake loop drops the tile at the deadline if no `state` event claims it (covers a head cancelled from another tab). Non-head removals are cancels by construction (only the head can start) and just disappear. |
| `encode` | `state.download?.jobId === payload.jobId` → update `framesDone/framesTotal`; on `done` → trigger `<a download>` of `outUrl`, `download = null`, `GET /api/sessions/{sessionId}` to refresh `artifacts`; on `failed`/`cancelled` → toast, `download = null`. Other jobs' events: ignored. |
| `log` | Ignored. The Create surface has no log chrome; the bench renders logs. |

### 6.3 Boot, reconnect, resync

- **Boot** (`dom/main.ts`): `Promise.all` of `GET /api/schema` (only
  `Object.keys(fields)` is kept → `schemaFields`), `GET /api/sessions`,
  `GET /api/queue`. All parsed; any failure → `boot = { phase: 'failed', message }`
  (full-surface error, §10.7). Then `readEnv()`, open SSE, `boot = ready`.
- **Reconnect**: `EventSource.onerror` → `sse.phase = 'retrying'` (subtle
  indicator, §10.1). On the next `onopen` → re-fetch `/api/sessions` +
  `/api/queue`, run `reconcileSessions(tiles, fresh)` (core): fresh summaries win;
  `live` telemetry and `detail` carry over for ids that are still `rendering`;
  tiles absent from fresh are dropped. SSE replay is bounded (1000-entry ring) —
  the snapshot is truth, SSE is deltas on top (inventory §1.18).
- The 15 s SSE comment heartbeat needs no client handling.

---

## 7. Gallery — kit/masonry mapping

### 7.1 Source

```ts
// core/gallery.ts
type GalleryEntry =
  | { kind: 'pending'; pending: Pending }
  | { kind: 'queued'; item: QueueItem }
  | { kind: 'session'; tile: Tile }

// Rebuilt each render (derived, ephemeral — recompute over cache):
//   [pending?, ...queue reversed, ...tiles] — pending first, then queued items
//   newest-enqueued-first so the head (#1, next to start) sits closest to the
//   live render, then tiles newest-first. A queued item's id IS its future
//   session id, so the DOM node (and its entry spring) carries over at start.
function deriveGallery(pending, queue, tiles): GalleryEntry[]

function makeMasonrySource(entries: GalleryEntry[]): MasonrySource<GalleryEntry> {
  return {
    groups: entries,                 // one group per entry — one generation job each,
    isGroupHidden: () => false,      //   so emitGroupTop gives per-session anchor reads
    tileCount: () => 1,
    isTileHidden: () => false,
    tileSizeY: (g, _i, colSizeX) => masonryCardHeight(colSizeX, entrySizeX(g), entrySizeY(g)),
  }
}
```

`entrySizeX/Y`: session → `tile.sizeX/sizeY`; pending → its composed dims.
`masonryCardHeight`'s 9/16–2x clamp (kit `mjFeel`) is adopted as-is.

### 7.2 Config and walk (in `dom/renderGallery.ts`, numbers in `core/feel.ts`)

- Scroller: `#gallery-scroll` (own scroller under the fixed bar), one absolute
  canvas `#gallery-canvas` whose height = `result.contentHeight`.
- `cols = masonryColumnCount(innerX - 2*feel.galleryPadX, feel.cardMinX = 220,
  minCols = 2, maxCols = 5)`; `colFractions = uniformColumnFractions(cols)`;
  `gap = 14`; `availableSizeX = innerX - 2*padX - gap*(cols-1)` (the
  `gap*(cols-1)` convention); `contentTop = 0` (the bar is outside the scroller).
- Viewport: `{ scrollTop: state.scrollTop, sizeY: scroller clientHeight from env-
  derived layout, lenienceY: 2 * viewportY }` (kit `mjFeel` cull lenience).
- Per frame: `placeMasonry(source, config, viewport, emitTile, emitGroupTop)`.
  `emitTile` gates on `cursor.inWindow`, **copies** the cursor fields it needs
  (never captures the cursor — kit poisoning contract), positions the entry's DOM
  node (`transform: translate`, width/height), and records the copied rect on the
  node cache entry (the lightbox open-anchor, A9).
- Node cache: `Map<entryKey, TileNodes>` keyed by session id / `'pending'`. JIT
  create on first in-window emit; mark-and-sweep per frame (nodes not emitted
  in-window this frame are detached and evicted) — the bench library-rail
  pattern, bounded DOM.
- Scroll anchoring: `anchorPin` holds the first in-window entry's key and its
  `emitGroupTop` y. When a prepend shifts it, apply `anchorScrollAdjustment` to
  the scroller and update `prevY` — new tiles land above without yanking the
  view. Pin updates on user scroll.
- `shouldFetchNextPage` is unused (the session list is not paginated). Do not
  wire it speculatively.

### 7.3 Tile anatomy and states

Every tile = image area (aspect from data) + a 1-line overlay footer that
**appears on hover only** (gallery chrome recedes; prompt text lives in the
lightbox). Exhaustive tile states:

| entry state | visual |
|---|---|
| pending `posting` | dashed 1px border, shimmer sweep, prompt's first words centered, no image |
| queued (one tile PER queue item) | as posting + `QUEUED #n` chip (its 1-based position, refreshed by every queue SSE event as the queue drains) + its own `×` cancel (A8) |
| pending `starting` | as posting + `STARTING` chip, no cancel |
| session `rendering` / `launching`/`loading_models` substate | skeleton shimmer (0 frames) or latest thumb; substate label (`warming up…` / `loading models…`); indeterminate bar; `◼ STOP` control top-right (A13 — keeps the work; visually distinct from the queued ×, which discards) |
| session `rendering` / `rendering` substate | latest thumb, swaps on every `frame` event; bottom progress bar `step/stepsTotal`; thin cyan pulse; `◼ STOP` control top-right |
| session `rendering` / `stopping` | as above + `STOPPING` chip, bar frozen, `◼ STOP` hidden (one-shot — the request is in flight) |
| session `done` | newest thumb; no chrome until hover |
| session `stopped` | newest thumb; small `◼ n frames` chip |
| session `failed` | thumb if `frames > 0` else dark slab; `FAILED` chip (danger); hover footer shows `failExcerpt` first line |
| session `imported` | newest thumb; `IMPORTED` chip on hover |

Thumb `src` = `thumbUrl(id, frames)`; skeleton shows until the `<img>` `load`
event (load state lives in the node cache, not app state). `frames === 0` →
placeholder, no request.

---

## 8. Lightbox — two-axis navigation, kit/reel-strip

Directive (2026-08-05, verbatim): *"lets change the lightbox. vertical scroll
and reel changes between the different jobs. horizontal scroll and a smaller
bottom reel changes between the frames of the job."*

Two axes, TikTok-style paging:

- **VERTICAL = JOBS.** Vertical wheel (and `↑`/`↓`) pages to the previous/next
  session in the gallery's display order (`tiles` newest-first), among sessions
  with `frames >= 1` — frameless sessions are skipped; rendering sessions with
  frames are live jobs and stay in. The JOBS REEL (vertical strip, right edge,
  the larger reel) shows one thumb per job — its LATEST frame, re-derived every
  walk so a rendering job's thumb advances as frames land. Click jumps to that
  job. Switching jobs lands on the target job's latest frame (`'follow'` when
  it renders).
- **HORIZONTAL = FRAMES.** Horizontal wheel (and `←`/`→`) scrubs frames within
  the open job. The FRAMES REEL (horizontal strip, bottom band above the
  chrome, the smaller reel — the image stays the hero) shows the job's frames;
  click jumps. A rendering job's new frames appear here as they land (positions
  walk `tile.frames`); when following, the focus rides the newest frame; a
  back-scrubbed pin is never yanked.

### 8.1 Sources and navigation

```ts
// core/lightbox.ts — frames axis: one group = the open session; items: frames 1..N
function makeFramesSource(tile: Tile): ReelSource<Tile> {
  return {
    groups: [tile],
    isGroupHidden: () => false,
    itemCount: () => tile.frames,
    isItemHidden: () => false,
    isItemHardHidden: () => false,
  }
}

// jobs axis: one group per session in gallery order, one item each; frameless hidden
function makeJobsSource(tiles: readonly Tile[]): ReelSource<Tile> {
  return {
    groups: tiles,
    isGroupHidden: (tile) => tile.frames < 1,
    itemCount: () => 1,
    isItemHidden: () => false,
    isItemHardHidden: () => false,
  }
}
```

`ItemRef.item` is 0-based; frame indices are 1-based (`frame = item + 1`) — the
conversion lives in `core/lightbox.ts` only, asserted at the boundary. On the
jobs axis, `ItemRef.group` is the tile's index in `tiles`; `jobRef(tiles,
sessionId)` derives it (the id is the stored fact, the index is derived).

- **Dominant axis** (`dominantAxis`): one swipe machine per axis (`swipeX`,
  `swipeY`), and a live gesture owns its axis until its accumulator decays to
  rest — at most one accumulator is non-zero at a time, and the other axis's
  wheel input is discarded meanwhile (trackpads leak small cross-axis deltas
  mid-gesture; those must not hop jobs during a frame scrub). From rest the
  larger `|delta|` picks the axis; ties go to the jobs axis (mouse wheels emit
  `deltaY` only, so a plain wheel pages jobs).
- **Wheel** (`applyWheel(lightbox, tiles, deltaX, deltaY)`, one step per frame):
  `swipeStep(direction, accumulated, delta, next, prev, threshold)` with
  `next/prev = reelNext/reelPrev(source, ref)` on the dominant axis. Thresholds
  page, not free-scroll: frames axis `feel.swipeThreshold = 60`; jobs axis
  `feel.jobSwipeThreshold = 120` — a job hop is a deliberate page turn, a frame
  step is a scrub. A frames-axis navigate sets `frame` (pin/follow rule, A10);
  a jobs-axis navigate lands on the target job's latest frame and resets both
  machines to rest.
- **Jobs reel**: vertical, right edge. `reelAnchorScan(jobsSource, ∞,
  mjFeel.itemSize = 56, mjFeel.groupGapY = 8, jobRef)` yields positions (each
  job is its own group, so the gap separates every pair and a swipe always
  crosses a group edge); `anchorMorph(swipeY.accumulated, jobThreshold,
  mjFeel.anchorSize = 68, itemSize)` sizes the focused vs incoming thumbs
  mid-swipe; `anchorTravelY` moves the focused thumb. Thumbs use
  `thumbUrl(id, tile.frames)` — the latest frame, derived.
- **Frames reel**: horizontal, bottom band. Same scan/morph math on the x axis
  with the smaller metrics `feel.frameItemSize = 40`, `feel.frameAnchorSize =
  48`, gap 0 (one group), driven by `swipeX`. Thumbs use `thumbUrl(id, frame)`.
  The thumb pool is keyed by frame index and valid for one session — a job
  switch drops it wholesale.
- Long sessions / many jobs: each strip renders only thumbs whose scan position
  falls in its band (the scan's positions are already ordered; slice by band).

### 8.2 Stage, open/close, chrome

- Stage image: `frameUrl(id, frame === 'follow' ? tile.frames : frame)`, PNG,
  double-buffered (two `<img>`, swap on `load` — never blanks; bench stage
  precedent). Preload `frame ± 1`.
- **Open morph**: spring-driven FLIP from `lightbox.anchor` (the copied masonry
  rect, A9) to the fitted stage rect (`fit(aspect, stageX, stageY)` from
  kit/midui; the stage area is the viewport minus the jobs band on the right and
  the frames band + chrome band at the bottom). One `Spring` per axis-pair (x,
  y, sizeX, sizeY) stepped on the fixed 6 ms timestep (`springStepCount` guard);
  scrim opacity tracks the size spring's progress. Close reverses to the tile's
  **current** placement rect (re-copied at close time from the node cache — the
  tile may have moved; after job switches this is the CURRENT job's tile). If
  the tile was evicted (scrolled far), fall back to a centered fade. Reduced
  motion (`env.reducedMotion`) → `springGoToEnd` immediately.
- Chrome (bottom band): full `scenes` text (1 line, ellipsis, click-to-expand to
  3 lines), params line, actions row. Params line from summary data immediately —
  `512×512 · 200/200 steps · seed 1234 · frame 12/30` — and gains the model name
  (`· Limited Palette`) once `tile.detail` resolves (fetched on open AND on
  every job switch, §4 `detail` — cached forever per session). Skeleton dashes
  while loading. Chrome and actions always describe the OPEN job.
- Actions row, exactly: `⟳ RE-RUN` (A3) · `✎ TWEAK` (A4) · `⚙ ADVANCED` (A5) ·
  `↓ DOWNLOAD` (A6, shows a progress ring while `download` is active for this
  session) · `✕ DELETE` (A7, disabled per its guards).

---

## 9. Toplayer, keyboard, chassis wiring

### 9.1 Z-ladder and surface list (`core/surfaces.ts`)

```ts
let d = 1
export const zLightbox = d++
export const zPopover = d++   // popover and lightbox are mutually exclusive by
export const zConfirm = d++   //   construction (opening one closes the other),
export const zToast = d++     //   but the ladder still totally orders them
```

`surfaces(state) -> Surface<CreateView>[]` where

```ts
type CreateView =
  | { type: 'lightbox' }                  // payload read from state at render
  | { type: 'popover' }
  | { type: 'confirm'; kind: 'delete'; sessionId: string }
  | { type: 'toast'; text: string }
```

The render root (`dom/renderTop.ts` + `renderLightbox.ts`/`renderBar.ts` for
their surfaces) renders `orderSurfaces(surfaces(state))` once per frame into one
`#toplayer` container — no portals, no per-surface mount gates. The popover is
positioned from the bar's **layout data** (bar geometry is fixed by the shell
CSS: centered, `feel.barMaxX` wide), not measured; `placeAtCursor` is not needed
(the popover anchors to the bar, not the cursor).

`topmostDismissable(state)`: `confirm` → `popover` → `lightbox` → `null`. Esc
dismisses exactly that one. Toasts are not Esc-dismissable; they expire via the
wake loop (`feel.toastMs = 4000`).

§15.7 inserts `zMaskEditor` between `zPopover` and `zConfirm`, adds a
`mask-editor` `CreateView` variant, and extends `topmostDismissable` to
`confirm` → `mask-editor` → `popover` → `lightbox` → `null`.

### 9.2 Keyboard (`core/keys.ts`)

`KeyFacts = { key, meta, ctrl, inInput }` (dom builds it from the event; `meta`
covers Cmd, `ctrl` for non-Mac parity) → `Intent`:

| binding | intent | scope |
|---|---|---|
| `Enter` | `submit` | bar focused only |
| `Cmd/Ctrl+Enter` | `rerun-last` | global |
| `Esc` | `dismiss` | global (topmost surface; else blur bar) |
| `/` | `focus-prompt` | global, unless `inInput` |
| `←` / `→` | `frame-prev` / `frame-next` | lightbox open only |
| `↑` / `↓` | `job-prev` / `job-next` | lightbox open only |

Exhaustive switch on the intent union in `dom/main.ts`. No other bindings.

### 9.3 Chassis wiring (`dom/main.ts`)

Exactly the chassis-notes composition:

- `rafRenderLoop(render)` — `render` projects the whole state each frame:
  bar/popover, gallery walk, lightbox, toplayer. Springs step inside `render`
  on the fixed timestep; `render` calls `loop.scheduleRender()` again while any
  spring is live (`!springMostlyDone`).
- `renderNow()` only in the prompt input's `input` handler (keystroke echo).
- `createWakeLoop` owns the two timed facts: toast expiry and the
  pending-`starting` grace deadline. Deadlines as data — no scattered
  `setTimeout`s. SSE/net handlers `invalidate()` it when they change either.
- `watchEnv` → `state.env = env; scheduleRender()`. Env is read nowhere else.
- `create.css` declares the four `--kit-safe-area-*` vars (kit/env contract).

---

## 10. Wireframes

### 10.1 Create — default (gallery is the hero)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                              ADVANCED ↗    │  ← corner link, dim
│        ┌──────────────────────────────────────────────────────┐            │
│        │ ⌕  infinite fractal mushroom forest | biolumin…  ⚙ ▶ │            │  ← bar, top-center
│        └──────────────────────────────────────────────────────┘            │     ⚙ popover · ▶ submit
│                                                                     ◌ sse  │  ← reconnect dot (only when retrying)
│   ┌──────────┐ ┌───────────────┐ ┌──────────┐ ┌───────────────┐            │
│   │          │ │               │ │          │ │               │            │
│   │  thumb   │ │    thumb      │ │ ▒▒▒▒▒▒▒▒ │ │    thumb      │            │
│   │          │ │               │ │ ▒ skel ▒ │ │               │            │
│   └──────────┘ │               │ │ ▒▒▒▒▒▒▒▒ │ └───────────────┘            │
│   ┌──────────┐ └───────────────┘ └──────────┘ ┌──────────┐                 │
│   │  thumb   │ ┌──────────┐  ┌───────────────┐│  thumb   │                 │
│   │          │ │  thumb   │  │     thumb     ││          │                 │
│   └──────────┘ └──────────┘  └───────────────┘└──────────┘                 │
└────────────────────────────────────────────────────────────────────────────┘
   masonry: 2–5 cols, 14px gap, newest top-left; hover → 1-line footer overlay
```

### 10.2 Settings popover (on the bar, springs open below the ⚙)

```
        ┌──────────────────────────────────────────────────────┐
        │ ⌕  prompt…                                       ⚙ ▶ │
        └───────────────────────────────────┬──────────────────┘
                                            │
                          ┌─────────────────▼───────────────────────────────┐
                          │ ASPECT   [1:1] [3:4] [4:3] [16:9] [AUTO]        │
                          │ SIZE     [DRAFT] [FULL]                         │
                          │ STEPS    [150][200][300][600][1200][2400][____] │
                          │ LOOK     [LIMITED] [UNLTD] [VQGAN]              │
                          │ SEED     [⚄ RANDOM] [🔒 3982117]                │
                          │ ▸ EXPERIMENTS                                   │
                          └─────────────────────────────────────────────────┘
   segmented chips, one selected per row — nothing else, ever. STEPS ends in
   the custom numeric input (§5.1): a non-preset value (e.g. 275) shows there,
   highlighted as the selection; preset values leave it empty. AUTO on the
   aspect row is enabled only while an attachment's natural dims are known
   (§5.1a).
   Tweak mode may show [CUSTOM] as the selected chip on the aspect/size/look
   rows (§5.3) — steps always shows its concrete number instead.

   ▸ EXPERIMENTS (§5.7) is collapsed by default — the everyday gear stays clean.
   Expanded ("i need access to the higher level experiment toggles in create"):

                          ┌─────────────────────────────────────────────────┐
                          │ …the five rows above…                           │
                          │ ▾ EXPERIMENTS                                   │
                          │ INIT NOISE      [WHITE] [PINK] [GRAY]           │
                          │ PYRAMID         [3] [2] [4] [OFF]               │
                          │ COHERENCE       [OFF] [ON]                      │
                          │ FULL VISION     [OFF] [ON]                      │
                          │ PHASE SCHEDULE  [OFF] [ON]                      │
                          │ AUTO-STOP       [OFF] [ON]                      │
                          └─────────────────────────────────────────────────┘
   same chip idiom, defaults first; every default = the engine/tuned default
   (untouched panel = byte-identical payload, §5.7). PYRAMID shows OFF and is
   disabled while HOLD MEANING is on. Tweak mode may show [CUSTOM] per row.
```

### 10.3 Tile states (gallery)

```
 posting/queued              rendering                    failed
┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐          ┌──────────────┐          ┌──────────────┐
│ ▒▒shimmer▒▒▒ │          │              │          │   dark slab  │
│  "infinite   │          │  live thumb  │          │              │
│   fractal…"  │          │              │          │  ✕ FAILED    │
│ QUEUED #2  × │          │ warming up…  │          │              │
└╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘          │━━━━━━╸ 62%   │          └──────────────┘
 dashed border            └──────────────┘           hover: failExcerpt
 one per queue item        bar = step/stepsTotal
 done (hover)
┌──────────────┐
│              │
│    thumb     │
│░░░░░░░░░░░░░░│ ← hover footer: "infinite fractal mush… · 30f · 4m12s"
└──────────────┘
```

### 10.4 Lightbox (kit/reel-strip, two axes)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ████████████████████████████ scrim ████████████████████████████████████████│
│                                                                      ┌───┐ │
│                ┌───────────────────────────────┐                     │ ▪ │ │ ← jobs reel:
│                │                               │                     │ ▪ │ │   one thumb per
│                │                               │                     ├───┤ │   session (its
│                │         frame 12 / 30         │                     │▐█▌│ │ ← latest frame);
│                │        (PNG, dbl-buffer)      │                     ├───┤ │   focused 68px
│                │                               │                     │ ▪ │ │   (anchorMorph),
│                │                               │                     │ ▪ │ │   resting 56px
│                └───────────────────────────────┘                     └───┘ │
│                    ▫ ▫ ▫ ▫ ▫ ▪ ▫ ▫ ▫ ▫                                     │ ← frames reel:
│                                                                            │   40px, focus 48px
│  infinite fractal mushroom forest | bioluminescent mycelium network | …    │
│  512×512 · 200/200 steps · Limited Palette · seed 3982117 · frame 12/30    │
│  ⟳ RE-RUN   ✎ TWEAK   ⚙ ADVANCED   ↓ DOWNLOAD   ✕ DELETE                   │
└────────────────────────────────────────────────────────────────────────────┘
  vertical wheel / ↑↓ = page JOBS (frameless sessions skipped; lands on latest)
  horizontal wheel / ←→ = scrub FRAMES · click either reel = jump · Esc = close
  live job: follows newest frame; any back-scrub pins; scrub-to-end refollows;
  its jobs-reel thumb and frames reel grow as frames land
```

### 10.5 Delete confirm (toplayer, above lightbox)

```
                 ┌─────────────────────────────────────────────┐
                 │  delete s-0014-infinite-fractal-mushroom?   │
                 │  frames, sidecar and artifacts are removed  │
                 │                                             │
                 │            [ CONFIRM ]   [ CANCEL ]         │
                 └─────────────────────────────────────────────┘
```

### 10.6 Empty state (no sessions, fresh install)

```
┌────────────────────────────────────────────────────────────────────────────┐
│        ┌──────────────────────────────────────────────────────┐            │
│        │ ⌕  describe a scene…                             ⚙ ▶ │            │
│        └──────────────────────────────────────────────────────┘            │
│                                                                            │
│                                                                            │
│                     type a prompt and press Enter                          │
│                  ( / focuses the bar · ⚙ sets size & look )                │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 10.7 Boot states

```
 loading:  bar disabled + 8 shimmer skeleton tiles in masonry positions
 failed:   centered — "can't reach the studio server"
           <message from the failed fetch>            [ RETRY ]
           (RETRY re-runs boot; nothing else on screen)
```

---

## 11. Aesthetic and motion (binding direction, not pixel law)

- **Dark, chrome recedes.** Tokens in `create.css`: `--bg: #0a0a0c`,
  `--tile: #16161a`, `--text: #9aa3ad`, `--dim: #5c636b`, `--accent: #00e5ff`
  (bench's cyan — one brand), `--danger: #ff3a3a`. The gallery images are the
  only saturated thing on screen until hover. Share Tech Mono for chrome text,
  system sans is not used.
- **Springs for reveals** (kit/midui, k=333 b=33 defaults unless `feel.ts` says
  otherwise): popover scale/opacity from the ⚙, lightbox open/close morph
  (§8.2), toast slide-up, tile entry (new tiles fade/rise 8px). All snap to end
  under `env.reducedMotion`.
- **Skeletons while thumbs load**: shimmer block sized by the data aspect —
  layout never reflows on image load.
- Progress bars are 2px, accent on `--tile`. The rendering tile's pulse is a
  slow 2s opacity breath on the bar, not a spinner.

---

## 12. Engineering gates

1. `bun run check` in `app/web/` passes: `tsc --noEmit` (strict set §1.3) +
   `bun test` (core test files + vendored kit tests).
2. Every `create/core/*.ts` file opens with a short `@cs`-style header (API
   summary; string/JSON-domain files declare themselves outside the freerange
   numeric subset and point at their test file).
3. No `any`; `unknown` only at parse boundaries. No `?.` chains on data the
   types say is present. Every union `switch` exhaustive (compile-time via
   `noFallthroughCasesInSwitch` + never-default).
4. Core imports: kit core files and other `create/core` files only (no
   `create/dom`, no kit `dom.ts`). Enforce by review; mirror kit rule 2.
5. Masonry cursor discipline: emit callbacks copy fields, never retain the
   cursor (kit poisoning contract) — reviewed explicitly.
6. **Do not commit** — the lead integrates.

---

## 13. Acceptance checklist (for the browser agent)

Environment: build (`cd app/web && bun run build`), then start a **dedicated**
server instance — `PYTTI_STUDIO_PORT=7911 python app/server.py` from the repo
root (or the launch script with that env). **Never open, curl, or automate
anything on port 7860.** Items marked ⚑ need a second short render; keep renders
DRAFT size / 1:1 / 150 steps so each finishes in ~1 minute on this machine.

1. `GET http://127.0.0.1:7911/` serves the Create shell; no console errors on
   load; the gallery shows existing sessions (or the §10.6 empty state on a
   fresh outputs dir).
2. `GET /bench.html` serves the full existing bench — library rail, stage,
   bench column all functional, no console errors, no behavior differences.
3. With at least one session present, `/bench.html#s=<that id>` boots the bench
   with that session staged (stage header shows its id).
4. On Create, pressing `/` focuses the prompt bar; typing echoes without caret
   jumps; Esc blurs.
5. ⚙ opens the settings popover with a spring; it contains exactly five rows —
   aspect (4 chips + AUTO, enabled per §5.1a), size (2), steps (6 numeric chips
   150–2400 + the custom input), look (3), seed toggle — plus the collapsed
   `▸ EXPERIMENTS` disclosure (§5.7) and nothing else; outside-click and Esc
   close it. Typing 275 in the custom input un-highlights
   every steps chip and highlights the input; clicking a steps chip empties it
   again; typing 20001 or junk marks the input invalid and keeps the last valid
   number — parsing is live, so valid prefixes commit as typed (20001 lands on
   the 2000 typed en route) and blur re-syncs the text to that committed value.
6. Type a prompt, Enter: an optimistic tile appears at the top-left **in the
   same frame** (before any network response — verify via throttled network),
   then transitions through `warming up…`/`loading models…` into a live
   progress bar.
7. ⚑ During the render, the tile's image updates at least twice (SSE `frame`
   events swapping the derived thumb URL), and the progress bar advances.
8. ⚑ On completion the tile settles to its newest thumb with no chrome; hover
   shows the one-line footer with the prompt text.
9. Popover 16:9 + FULL + 200, submit: the finished session's params line in the
   lightbox reads `640×360 · 200/200 steps`. 1:1 + DRAFT + 150 reads
   `256×256 · 150/150 steps`. 1:1 + DRAFT + 300 reads `256×256 · 300/300 steps`
   (steps decoupled from size).
10. Seed: two consecutive submits with seed RANDOM and identical prompt produce
    different seeds (params lines differ). Toggle seed LOCKED (a number
    appears), submit twice: both sessions show that same seed.
11. ⚑ Submit while a render is live: the new tile shows `QUEUED #1` with an ×.
    Submitting again ADDS a second tile showing `QUEUED #2` (§2.5 — never
    replaces); a third shows `#3`. Positions refresh as the queue drains.
12. Clicking × on ONE queued tile removes exactly that item; the tiles behind
    it renumber (`GET /api/queue` on 7911 shows the remaining items with
    positions 1..n). The running render is untouched.
13. ⚑ The `#1` queued tile auto-starts when the live render finishes (done,
    failed, OR stopped) — it becomes a rendering tile without any page
    interaction, and the remaining queued tiles each move up one position.
14. Masonry: resizing the window changes the column count (2–5); no
    overlapping tiles at any width; tiles keep their aspect ratios.
15. While scrolled down the gallery, a new session prepending does not shift
    the viewport (scroll anchoring).
16. Thumbs show a shimmer skeleton until loaded; layout does not reflow when
    images arrive.
17. Clicking a finished tile opens the lightbox with a morph from the tile's
    rect; Esc morphs it back to the same tile.
18. Lightbox frames axis: horizontal wheel scrubs frames (the bottom reel's
    focused thumb grows/shrinks through the swipe); `←`/`→` step exactly one
    frame; clicking a bottom-reel thumb jumps to it; the counter reads
    `frame i/N` correctly (1-based, N = frames).
18b. Lightbox jobs axis: vertical wheel pages to the previous/next session with
    frames (gallery order, frameless sessions skipped); `↑`/`↓` step exactly
    one job; clicking a jobs-reel thumb jumps to that job; every job landing
    shows that job's LATEST frame, and prompt/params/actions switch with it.
19. ⚑ Opening the lightbox on a rendering session follows the newest frame as
    it lands (the bottom reel grows with it); scrubbing backward pins;
    scrubbing forward to the newest frame resumes following.
20. The lightbox shows the full prompt (`scenes`) text and a params line
    including dims, steps, model name, seed.
21. RE-RUN creates a new session whose config matches the source except the
    seed (verify: both params lines identical but seeds differ; `forkedFrom`
    visible on the new session in the bench inspector).
22. TWEAK closes the lightbox, prefills the bar with the source `scenes`, sets
    the popover chips to the source's presets (or CUSTOM where no preset
    matches), and locks the seed to the source seed; submitting creates a
    session with `forkedFrom` = source id.
23. ADVANCED in the lightbox opens `/bench.html#s=<id>` in a new tab with that
    session staged.
24. DOWNLOAD on a session with no artifacts starts an encode (progress shown on
    the button), and the finished mp4 downloads automatically; the artifact
    then appears in the bench for that session.
25. DELETE shows the confirm surface; CONFIRM removes the tile and the session
    disappears from `GET /api/sessions` (7911); CANCEL leaves it untouched.
26. DELETE is disabled (visibly) on a rendering tile, and on a session whose
    encode is in flight.
27. Cmd+Enter (Ctrl+Enter on non-Mac) from anywhere on the page re-runs the
    last submission (new optimistic tile, same settings). With no prior
    submission this session, it toasts `nothing to re-run`.
28. Esc order: with confirm open over the lightbox, Esc closes only the
    confirm; next Esc closes the lightbox; popover behaves the same when open.
29. Submitting a prompt containing a no-text weight segment (e.g.
    `mushroom | ::1` — the `::1` piece has a weight but no prompt text) produces
    a preflight error toast naming the field (`scenes: Prompt '::1' has no
    text…`) and leaves **no** tile behind. (Changed 2026-08-01: the previous
    example, `mushroom::bad:::1`, is deliberately **accepted** — the server's
    colon parsing is lenient by design and weights stay expression strings until
    render time; only an empty prompt text before the `:`/`::` separators is a
    preflight rejection.)
30. Kill the 7911 server: Create shows the reconnect indicator; restart it: the
    indicator clears and the gallery resyncs (no duplicate or ghost tiles).
31. With `prefers-reduced-motion: reduce` emulated, popover/lightbox/toast
    appear instantly (no springs), and everything remains functional.
32. `cd app/web && bun run check` exits 0; `app/static/create.js` is ≤ 100 KB;
    the page loads no framework (no react/vue/etc. in the bundle or network
    panel).

Items 33–48 (image input + mask, §15) continue this list in §15.11; items 52–54
(the EXPERIMENTS panel, §5.7) follow them there. Item 5's "exactly five rows"
holds only while no image is attached — see §15.5.

---

## 14. Known + accepted caveats

Reviewed, deliberately not fixed — each is transient and self-resolving:

- **ms-scale transient duplicate tile (races #4)**: an SSE `state` event racing ahead
  of its own POST response can insert the fetched real tile while the optimistic
  `posting` tile (which has no id yet to match) is still up, until the POST response
  clears it milliseconds later — imperceptible, self-resolving.
- **Ghost STARTING replay (browser F2)**: bounded SSE replay after a reconnect can
  resurrect a `STARTING` pending tile for a session that already started or finished;
  the starting-grace deadline (`feel.startingGraceMs`, 15 s) drops it — self-heals,
  no user action needed.

---

## 15. Image input — init attachment + mask (added 2026-08-03)

**Status: binding**, same authority as the rest of this document. This section is
additive: §§4–13 stand as written except where an "amends" note below says
otherwise. The lead's rulings (attach-on-bar, INIT row presets, hold-meaning
toggle + torch pin, paint-surface mask with white-equals-hold semantics, tweak/re-run
rematerialization, no-empty-init-keys, error states) are restated here as spec.

### 15.1 Engine contract (verified against pytti-core, read-only checkout)

- `init_image` is a plain `str` path (`structured_config.py` line 51, default
  `""`). The engine stretches it to `width × height` — attaching an image does
  **not** auto-switch the aspect preset; matching them is the user's call (no
  silent state changes). The **opt-in** path is the AUTO aspect chip (§5.1a),
  which the user selects explicitly.
- `direct_init_weight` / `semantic_init_weight` are `str` weight expressions
  (lines 52–53, default `""`). Weight fields support the `weight_mask` grammar
  (`prompt_spec.py` `parse_weight_spec` line 145 / `parse_mask_token` line 119):
  `"<weight>_[<abs path>]"`, with a `-` **inside the bracket** prefixing the path
  for inversion — `"4_[-/abs/mask.png]"` (line 126–128). A third `_` field is a
  cutoff expression; Create never emits one.
- Mask semantics: the mask PNG is opened `convert("L")` and **multiplies the
  direct loss**; inversion is `1 - mask` (`MSELossClass.py` lines 72, 106). So
  **white = the init holds there**, black = free to diverge. UI copy must say
  this plainly.
- `semantic_init_weight` builds an image-embedding prompt
  (`LossOrchestratorClass.py` line 71) and **requires `perceptor_backend:
  torch`** — both mlx backends fail loud on it by design. Plain direct init +
  image mask runs fine on the default `mlx_full` (the M2 MSE port includes mask
  semantics).
- Preflight already validates `init_image` existence server-side (`server.py`
  line 380 path-field loop) — a vanished upload becomes the existing A1 preflight
  toast, no new client check needed.

### 15.2 Server prerequisites — S3 (REQUIRED)

Uploads live in `app/uploads/` and are referenced by **absolute path**.

- **Reuse** `POST /api/uploads` (`server.py` `_post_upload`, line 1522):
  multipart/form-data, first file part is saved under `UPLOADS_DIR` with a
  sanitized name, name collisions dedupe as `stem-N.suffix` (so an upload path
  is never overwritten — upload URLs are immutable). Responds `200 {"path":
  "<abs path>"}` (note: 200, not 201). Errors are the standard `{error}` body.
- **Add** a read route (nothing serves `app/uploads/` today — `do_GET` only
  serves `STATIC_DIR` and session subresources; tweak rematerialization needs to
  display a previously-uploaded image). House style follows `/api/browse`'s
  query-param path (line 1342) and the static branch's containment check
  (line 1358):

  ```python
  elif path == "/api/uploads":
      qs = urllib.parse.parse_qs(parsed.query)
      target = Path(qs.get("path", [""])[0]).expanduser().resolve()
      if target.parent == UPLOADS_DIR.resolve() and target.is_file():
          self._send_file(target, immutable=True)  # mime guessed; names never reused
      else:
          self._json(404, {"error": "not an upload"})
  ```

  The **server** owns "what is an upload" — the client never path-matches
  against a directory heuristic. Any path outside `UPLOADS_DIR` (including
  bench-browsed init images from tweak bases) is a 404; the client degrades per
  §15.8.

No other server change.

### 15.3 State additions (`core/model.ts`) and new files

```ts
// core/init.ts (string domain — outside freerange's numeric subset; init.test.ts
// is the checked surface)
type InitStrengthId = 'subtle' | 'medium' | 'strong'   // 1.5 / 4 / 10

type NaturalDims = { width: number; height: number }

type InitImage =
  | { kind: 'uploading'; name: string; localUrl: string }
  | { kind: 'ready'; name: string; path: string; localUrl: string | null;
      natural: NaturalDims | null }
    // localUrl: object URL when attached this session (created/revoked by dom —
    //   it enters core as boundary data, like `now`); null when rematerialized
    //   from a tweak base (display goes through uploadUrl(path), §15.8)
    // natural: the image file's own pixel dims — the AUTO aspect's input (§5.1a).
    //   Read client-side by dom (Image load) and handed to core as boundary data:
    //   fresh attaches decode the object URL alongside the upload so a ready fresh
    //   image always carries them (or a decode-failed null); rematerialized
    //   attachments start null and load async via uploadUrl (§15.8) — null keeps
    //   AUTO disabled, nothing more.

type InitMask = { path: string; inverted: boolean }    // abs path of the mask PNG upload

type InitAttachment = {
  image: InitImage
  strength: InitStrengthId | null   // null = CUSTOM — inherit the base's weight
                                    //   expression; reachable ONLY while tweak != null
                                    //   (mirrors aspect/size/steps/look, §4)
  holdMeaning: boolean              // semantic_init_weight + torch pin (§15.6)
  mask: InitMask | null
}

// core/model.ts
Composer gains:      init: InitAttachment | null
CreateState gains:   maskEditor: MaskEditor | null          // §15.7
confirm widens to:   { kind: 'delete'; sessionId: string }
                   | { kind: 'discard-mask' }               // §15.7 Esc guard
```

`reconcileSessions`'s confirm-close rule applies to `kind: 'delete'` only —
`discard-mask` has no session and survives a resync.

No mirrors: the tweak base's `direct_init_weight` string is **derived at need**
from `composer.tweak.baseValues` via `parseInitWeight` (§15.6), never copied into
`InitAttachment`.

New files (extends the §3 tree):

```
create/core/init.ts        # strength table; parseInitWeight/formatInitWeight (the
                           #   weight_mask codec, Create's subset); matchStrength;
                           #   deriveInitFromBase (tweak rematerialization)  [+ .test.ts]
create/core/mask.ts        # PURE editor geometry (freerange numeric subset, pinned in
                           #   fr-audit.ts): viewToImage pointer mapping, strokeStamps
                           #   interpolation, brush-size clamp. Fit rect comes from
                           #   kit/midui fit — not re-derived here.        [+ .test.ts]
create/dom/renderMask.ts   # the paint surface: canvases, pointer strokes, PNG export
```

`dom/net.ts` gains `uploadFile(data: File | Blob, name: string)` →
`POST /api/uploads` (FormData) → parsed by `core/api.ts` `parseUploadResult(raw)
-> string` (the abs path). `core/api.ts` also gains `uploadUrl(absPath) ->
string` = `'/api/uploads?path=' + encodeURIComponent(absPath)` (the server
decides validity, §15.2).

New `feel.ts` constants: `chipThumbSize: 28`, `maskBrushDefault: 48`,
`maskBrushMin: 8`, `maskBrushMax: 160`, `maskStampSpacingFrac: 0.25` (stamp
interval as a fraction of brush size), `maskEditorMargin: 24`,
`maskToolbarY: 56`.

### 15.4 Attaching — bar button, drag-drop, paste (amends A1's guard list)

Three attach routes, one result:

1. **⊕ button** on the bar (left of ⚙): opens a file picker
   (`accept="image/png,image/jpeg,image/webp,image/bmp"` — the suffixes
   `parse_mask_token` recognizes, minus mp4).
2. **Drag-drop onto the bar**: the bar (only the bar, not the whole page) is the
   drop target; dragover shows an accent inset ring.
3. **Paste** while the bar is focused: first image item of the clipboard.

Non-image payloads are ignored silently at all three (a text paste must keep
working as text — this is an input-type boundary, not an error).

Attach flow (dom): create an object URL → `composer.init = { image: { kind:
'uploading', name, localUrl }, strength: 'medium', holdMeaning: false, mask:
null }` → the chip renders this frame → `uploadFile(...)` **and** an `Image`
decode of the object URL for the natural dims, awaited together — both land
before 'ready', so a ready fresh attachment always knows its dims (§5.1a; a
failed decode resolves `natural: null` and AUTO just stays disabled). On `200` →
`image = { kind: 'ready', path, name, localUrl, natural }`. On any failure
(non-200, network) → toast `parseErrorBody` (or `upload failed`),
`composer.init = null`, revoke the object URL (ruling 6). Attaching while a
chip exists **replaces** it (old object URL revoked, mask cleared — a new image
invalidates a mask painted on the old one; a selected AUTO aspect stays and
re-derives from the new image, §5.1a).

Every attachment write — attach, replace, chip ✕, bar clear, upload failure,
tweak rematerialization — routes through core `replaceInit` (dom's `setInit`
wraps it with the object-URL revoke), which owns the §5.1a revert: clearing the
attachment while `aspect === 'auto'` reverts the aspect to `1:1` in the same
transition.

**Chip anatomy** (in the bar, between the input and ⚙): `[28px thumb] MASK ✕`.
Thumb from `localUrl` (fresh) or `uploadUrl(path)` (rematerialized). `✕` →
`composer.init = null` — clears chip, mask, and INIT row in one gesture
(ruling 6). `MASK` opens the paint surface (§15.7); it is disabled while `image.
kind === 'uploading'`, when the thumb failed to load (§15.8), or when the tweak
base's weight is opaque (§15.6). A saved mask renders the affordance as
`MASK ✓`.

**A1 guard additions**: submitting while `init.image.kind === 'uploading'` →
toast `image still uploading`, no optimistic tile, stop. Submitting with
`aspect === 'auto'` while the attachment's dims are unknown (rematerialized
load in flight, or an unreadable image) → toast `image size unknown — pick an
aspect`, stop (§5.1a — composeSubmission would rightly throw past this point).
**Bar-clear rule extension** (A1 step 4): clearing the bar resets the *whole*
composer — tweak AND attachment (chip, mask, INIT row) — so `strength: null`
stays unreachable outside tweak mode, mirroring the aspect/size/steps
invariant.

### 15.5 INIT row (settings popover — amends §10.2 and checklist item 5)

The row exists **iff** `composer.init != null` (the popover has five rows
without an attachment, six with — item 5 is amended accordingly):

```
   ┌─────────────────────────────────────────────────┐
   │ ASPECT   [1:1] [3:4] [4:3] [16:9] [AUTO]        │
   │ SIZE     [DRAFT] [FULL]                         │
   │ STEPS    [150][200][300][600][1200][2400][____] │
   │ LOOK     [LIMITED] [UNLTD] [VQGAN]              │
   │ SEED     [⚄ RANDOM] [🔒 3982117]                │
   │ INIT     [SUBTLE] [MEDIUM] [STRONG]  ◈ HOLD     │
   │          torch engine                           │  ← note, only while HOLD is on
   └─────────────────────────────────────────────────┘
```

- Strength chips map to `direct_init_weight` `1.5 / 4 / 10`; **medium is the
  default** on attach. In tweak mode the row may show `[CUSTOM]` selected
  (`strength: null`, §15.6) — same convention as §5.3.
- `◈ HOLD` ("hold meaning") toggle: **on** → the submission carries
  `semantic_init_weight: '0.3'` **and pins `perceptor_backend: 'torch'`**, and
  the row shows a small dim `torch engine` note. **Off** → it pins *nothing* —
  neither key is emitted; the backend rides the default (fresh) or the tweak
  base (tweak).
- Popover edits still touch `composer` only — no network (A11 unchanged).

### 15.6 `composeSubmission` changes (`core/presets.ts` + `core/init.ts`)

`ComposerSubmitInput` gains `init: InitSubmitInput | null`:

```ts
type InitSubmitInput = {
  path: string                     // image.kind must be 'ready' (A1 guard, §15.4)
  strength: InitStrengthId | null
  holdMeaning: boolean
  mask: InitMask | null
}
```

`SubmissionPayload` is unchanged in shape — the init fields ride inside `values`.

The codec (`core/init.ts`), Create's subset of the engine grammar:

```ts
formatInitWeight(weight: string, mask: InitMask | null): string
  // mask == null → weight;  else `${weight}_[${mask.inverted ? '-' : ''}${mask.path}]`

parseInitWeight(raw: string):
  | { kind: 'none' }                        // '' or a plain-number zero
  | { kind: 'simple'; weight: string; mask: InitMask | null }
    // plain weight expr, optionally one bracketed image-path mask (either '-' position)
  | { kind: 'opaque'; raw: string }         // cutoff field, video/semantic/geometric
                                            //   masks, anything else bench-authorable

matchStrength(weight: string): InitStrengthId | null   // exact match on the three
  // preset values (plain-number strings only) — no nearest-neighbor, per §5.3 doctrine
```

**Fresh** (`tweak == null`, `init != null`) — `strength` must be concrete (throw
on null: caller-contract violation, unreachable per §15.4's bar-clear rule).
`values` gains:

- `init_image: init.path`
- `direct_init_weight: formatInitWeight(STRENGTH[init.strength], init.mask)`
- iff `holdMeaning`: `semantic_init_weight: '0.3'` **and**
  `perceptor_backend: 'torch'`

`init == null` → **none of the four keys appear** (ruling 5: never emit
empty-string init keys; schema defaults cover absence). Fresh submissions still
pin `animation_mode: 'off'` exactly as before.

**Tweak** (`tweak != null`) — base values ride, overrides only where the
composer differs from the base (`base = parseInitWeight(String(
baseValues['direct_init_weight'] ?? ''))`, `baseOn = semantic_init_weight` not
in `{'', '0'}`):

- `init == null` (user removed the chip): `delete` `init_image`,
  `direct_init_weight`, `semantic_init_weight` from `values` (the server's
  defaults-compose restores schema defaults — same mechanism as random-seed's
  `delete`).
  `perceptor_backend` is left untouched (a base's deliberate backend choice is
  not Create's to revert).
- `init != null`:
  - `values['init_image'] = init.path` (unconditional — cheap, correct).
  - **direct**: if `strength == null` AND the mask state equals the base's
    (`simple` with same path+inverted, or untouched `opaque`) → **no override**,
    the base string rides verbatim (this is how an opaque base — cutoffs, video
    masks — survives a tweak untouched). Otherwise compose:
    `weight = strength != null ? STRENGTH[strength] : base.weight` (base is
    `simple` here by construction — mask editing is disabled on opaque bases,
    §15.4 — assert it), `values['direct_init_weight'] =
    formatInitWeight(weight, init.mask)`. A base cutoff does not survive a
    recompose — accepted, documented here.
  - **semantic**: `holdMeaning === baseOn` → no override (a non-0.3 base value
    rides verbatim). Toggled on → `values['semantic_init_weight'] = '0.3'`.
    Toggled off → `delete values['semantic_init_weight']`.
  - **backend**: `holdMeaning` → `values['perceptor_backend'] = 'torch'`
    (unconditional when on — covers legacy/imported bases whose snapshot lacks a
    backend); off → untouched.

`matchPresets` is **not** widened — init has its own reverse map,
`deriveInitFromBase(baseValues)` (§15.8). `composerDims` reads the init only
for the AUTO aspect (§5.1a: `init.natural` feeds the dims); every other aspect
is unaffected by the attachment.

### 15.7 The mask editor (paint surface)

**Surface.** Toplayer, lightbox-class scrim. §9.1 amendments:

```ts
let d = 1
export const zLightbox = d++
export const zPopover = d++
export const zMaskEditor = d++   // opens from the bar chip; opening it closes the
export const zConfirm = d++      //   popover (mutual exclusion by construction —
export const zToast = d++        //   same convention as popover/lightbox)

CreateView gains        { type: 'mask-editor' }
confirm view widens to  { type: 'confirm'; kind: 'delete' | 'discard-mask'; ... }
topmostDismissable:     confirm → mask-editor → popover → lightbox → null
```

The mask editor is unreachable without an image by construction (its only
entry point is the chip's MASK affordance — ruling 6's "mask without an image"
state cannot occur).

**State.**

```ts
type MaskEditor = {
  brushSize: number                 // px in view space, feel.maskBrushMin..Max
  mode: 'paint' | 'erase'
  inverted: boolean                 // initialized from init.mask?.inverted ?? false
  dirty: boolean                    // any stroke/clear since open (drives the Esc confirm)
  saving: boolean                   // POST in flight; SAVE disabled meanwhile
}
```

The **pixels are dom scratch**, not state (precedent: springs, node caches): an
offscreen `<canvas>` at the image's **natural resolution** beside the store,
plus its on-screen projection. Opening with an existing mask draws
`uploadUrl(mask.path)` onto the canvas first. Load failure fail-softs — toast
`existing mask not readable — starting blank`, blank canvas — **and drops
`init.mask` in the same transition** (core `dropUnreadableMask`): a dead path
left on the composer would ride an invert-only SAVE or the next submit, and
what the user sees (blank, no mask) must be what submits.

**Geometry (core/mask.ts — pure, numeric, freerange-pinned).** The image renders
at fit size: `fit(imgAspect, viewX - 2*feel.maskEditorMargin, viewY -
2*feel.maskEditorMargin - feel.maskToolbarY)` from kit/midui — core/mask.ts does
not re-derive fitting. It owns:

- `viewToImage(px, py, fitRect, imgSizeX, imgSizeY) -> {x, y}` — pointer to
  image-pixel space (the canvas paints at image resolution; brush size scales by
  the same factor).
- `strokeStamps(fromX, fromY, toX, toY, spacing) -> number[]` (flat x,y pairs) —
  stamp interpolation so fast drags leave no gaps; `spacing =
  brushSize * feel.maskStampSpacingFrac`, guard-derived per freerange.
- `clampBrushSize(raw) -> number`.

**Painting (dom/renderMask.ts).** Pointer strokes stamp white circles
(`mode: 'paint'`) or punch to black (`'erase'`, `destination-out` onto the
black-filled base). On-screen, the **hold region is tinted accent (~55%)** over
the dimmed image; `INVERT` flips *which region shows the tint* — the overlay
always shows where the init holds, and the toggle only flips
`maskEditor.inverted` (exported PNG is identical; the `-` goes inside the
bracket at compose time). Toolbar: `PAINT · ERASE · INVERT · CLEAR ·
brush-size slider` + (`REMOVE MASK` iff `init.mask != null`) + `SAVE` + header
copy, plainly: **"paint where the image should hold — tinted = held"**.

**Save.** Composite the canvas onto black → white-on-black PNG blob at image
resolution (engine `convert("L")`s it) → one `getImageData` scan: if no pixel
> 0 → toast `mask is empty — paint where the image should hold`, stay open.
Else `uploadFile(blob, 'mask-' + imageStem + '.png')` (`saving: true`) → 200 →
`init.mask = { path, inverted }`, `maskEditor = null`. Failure → toast, editor
**stays open** (painted work is never destroyed by a network error).
**Invert-only edit** (existing mask, no strokes): SAVE skips the re-upload and
just flips `init.mask.inverted` on the existing path. `REMOVE MASK` → `init.mask
= null`, close.

**Keyboard & focus containment (amends §9.2's scope table, not `keyIntent`).**
No new bindings — the tools are pointer-only; the intent map is unchanged.
Scope rule: while `maskEditor != null`, **only the editor's own controls and
the surfaces above it (discard confirm, toast) act.** Three mechanisms
enforce that — the intent guard alone was not containment, because Tab and
native Space/Enter activation are not in the intent map:

- the dom dispatcher acts on `dismiss` **only** (submit, rerun-last,
  focus-prompt, frame-prev/next are inert);
- the background shell (bar + popover, gallery, lightbox, header link, boot
  surfaces) is `inert` while the editor is open, projected from
  `maskEditor != null` each frame — the scrim only blocks pointers; `inert`
  also removes tab focus and keyboard activation;
- the element focused at open (the MASK chip, on a keyboard activation) is
  blurred, and opening is a **state no-op while the editor is already open**
  (core `openMaskEditor` returns false) — re-entry must never replace an
  editor holding unsaved strokes.

Esc layering:

- `dirty && !saving` → `confirm = { kind: 'discard-mask' }` (surface above the
  editor). Its CONFIRM → `maskEditor = null` (chip's previous mask state
  untouched); CANCEL/Esc → closes only the confirm, editor intact.
- `!dirty` → `maskEditor = null` immediately.
- Outside-click on the scrim follows the same rule as Esc.

### 15.8 Tweak / Re-run rematerialization (amends A3, A4)

Fork snapshots already carry `init_image` / `direct_init_weight` /
`semantic_init_weight`, and all three are schema fields — so they pass
`submittableValues` and ride A3/A2 **verbatim with zero new code**: Re-run and
Cmd+Enter replay the init exactly (only the seed differs on A3, per its design).

**A4 (Tweak) gains one step** — after `matchPresets`, derive the attachment
(`core/init.ts deriveInitFromBase(baseValues) -> InitAttachment | null`):

- `init_image` empty → `init = null` (no chip). Else chip with `image = { kind:
  'ready', path, name: basename, localUrl: null, natural: null }` — thumb via
  `uploadUrl(path)`. The natural dims load async (dom, `Image` decode of
  `uploadUrl(path)`, §5.1a): on load they land on the still-current attachment
  and AUTO becomes selectable; a 404 (bench-external image) or undecodable file
  leaves them null — AUTO stays disabled, no other degradation.
- `strength = matchStrength(base.weight)` when `parseInitWeight` says `simple`
  (miss → `null` = CUSTOM chip); `opaque` → `null` + MASK affordance disabled
  (title: `bench-authored weight — attach a new image to repaint`). Picking a
  concrete strength on an opaque base recomposes from composer state per §15.6
  (the opaque tail is deliberately dropped).
- `mask` from the `simple` parse's bracket token (path + inverted); `holdMeaning
  = baseOn`.
- Display degradation is the **server's** call (§15.2): a base `init_image`
  outside `app/uploads/` 404s → the chip thumb's `onerror` (node-cache fact,
  like gallery thumb loads) renders a thumbless basename chip and disables MASK
  — strength/hold/submit all still work, and an untouched weight string rides
  verbatim.

The chip persists across a tweak submit (same as tweak itself, A1 step 4);
clearing the bar clears it (§15.4).

### 15.9 Error and empty states (ruling 6, consolidated)

| state | behavior |
|---|---|
| upload failure (attach) | toast; chip cleared; object URL revoked (§15.4) |
| upload failure (mask save) | toast; editor stays open, painting preserved (§15.7) |
| submit while image uploading | toast `image still uploading`; no optimistic tile |
| mask without an image | unreachable by construction (§15.7) |
| remove image (chip ✕) | clears chip + mask + INIT row in one gesture |
| empty (all-black) mask save | toast; editor stays open (§15.7) |
| init file deleted before submit | server preflight 400 → existing A1 toast path (§15.1) |
| tweak-base image not an upload | thumbless chip, MASK disabled; weight rides verbatim (§15.8); natural dims never load → AUTO stays disabled (§5.1a) |
| submit with AUTO while dims unknown | toast `image size unknown — pick an aspect`; no optimistic tile (§15.4) |
| remove image while AUTO selected | aspect visibly reverts to `1:1` in the same transition (§5.1a) |
| stale mask thumb/PNG unreadable | fail-soft: thumbs degrade at the display boundary (§15.8); in the editor the unreadable mask also drops `init.mask` (§15.7) — never blocks submit |

### 15.10 Wireframes

Bar with chip (extends §10.1):

```
   ┌────────────────────────────────────────────────────────────────┐
   │ ⌕  overgrown cathedral, dawn light   ┌──┐ MASK ✓ ✕   ⊕  ⚙  ▶  │
   │                                      │▒▒│                      │
   └────────────────────────────────────  └──┘  ────────────────────┘
        chip: 28px thumb · MASK affordance (✓ when saved) · ✕ remove
```

Mask editor (toplayer, lightbox-class):

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ████████████████████████████ scrim ████████████████████████████████████████│
│   paint where the image should hold — tinted = held                        │
│                ┌───────────────────────────────┐                           │
│                │            image              │                           │
│                │      ▓▓▓▓ (accent tint =      │                           │
│                │      ▓▓▓▓▓▓  hold region)     │                           │
│                │         ▓▓▓                   │                           │
│                └───────────────────────────────┘                           │
│   [PAINT] [ERASE] [INVERT] [CLEAR]  brush ●───────  [REMOVE MASK] [SAVE]   │
└────────────────────────────────────────────────────────────────────────────┘
  Esc: dirty → discard confirm; clean → close · wheel/keys inert while open
```

### 15.11 Acceptance checklist additions (continues §13; same environment rules)

33. Attach via the bar's ⊕ file picker: the chip appears with a thumbnail, ✕,
    and MASK affordance; the network panel shows one `POST /api/uploads`
    returning a path under `app/uploads/`; the popover now shows the INIT row
    (MEDIUM selected, HOLD off, no torch note).
34. Drag-drop an image file onto the bar and paste an image from the clipboard
    each produce the same chip + INIT row. Dropping/pasting non-image data does
    nothing (no chip, no request, no console error).
35. With the 7911 server killed, attaching toasts the failure and clears the
    chip (no INIT row remains); after restart, re-attaching works.
36. ⚑ Submit with an attached image at MEDIUM: the created session's config
    (bench inspector, or `GET /api/sessions/{id}` on 7911) shows `init_image`
    = the absolute upload path and `direct_init_weight` `"4"`, with
    `semantic_init_weight` at its schema default; `GET /api/draft` is
    **unchanged** by the submit (§5.6); the render completes on the default
    backend and frame 1 visibly starts from the attached image.
37. SUBTLE and STRONG submissions carry `direct_init_weight` `"1.5"` /
    `"10"` respectively (bench inspector on the created sessions).
38. ⚑ HOLD MEANING on: the INIT row shows the `torch engine` note; the
    submitted config has `semantic_init_weight` `"0.3"` **and**
    `perceptor_backend` `"torch"`; the render completes.
39. Submit with no image attached: the POST body's `values` contain none of
    `init_image` / `direct_init_weight` / `semantic_init_weight` (keys absent,
    not empty strings — network panel on the `/api/sessions` request).
40. MASK opens the paint surface: image at fit size; PAINT tints the stroked
    region accent; ERASE removes it; the brush-size slider changes stamp
    diameter; CLEAR wipes; the header copy states painted = where the image
    holds.
41. ⚑ SAVE uploads a white-on-black PNG (`POST /api/uploads`, `mask-*.png`),
    closes the editor, and the chip reads `MASK ✓`; the submitted
    `direct_init_weight` is `4_[/abs/.../mask-*.png]`. With INVERT on, the
    bracket carries the leading `-`: `4_[-/abs/.../mask-*.png]`.
42. Saving an all-black (empty) mask toasts `mask is empty — paint where the
    image should hold` and keeps the editor open.
43. Esc layering: Esc in the editor with unsaved strokes opens the discard
    confirm; Esc again closes only the confirm (editor + painting intact);
    CONFIRM discards (editor closes, the chip's previous mask state unchanged).
    Esc with no strokes closes the editor immediately. `/`, `←`/`→`, Enter and
    Cmd+Enter are inert while the editor is open.
44. Removing the image (chip ✕) clears chip, mask, and INIT row in one gesture;
    clearing the bar does the same (full composer reset). Re-attaching starts
    fresh: MEDIUM, HOLD off, no mask.
45. TWEAK on an init session rematerializes the chip (thumb served by
    `GET /api/uploads?path=…`), the strength chip (or CUSTOM for a non-preset
    base weight), the HOLD toggle, and `MASK ✓` whose editor re-opens showing
    the existing painted region; an INVERT-only edit re-submits with the `-`
    flipped and **no** new upload.
46. RE-RUN on an init session creates a session whose `init_image` /
    `direct_init_weight` / `semantic_init_weight` match the source exactly
    (seed differs); Cmd+Enter after an init submit replays the init keys
    verbatim.
47. `curl 'http://127.0.0.1:7911/api/uploads?path=/etc/hosts'` (and any path
    outside `app/uploads/`) returns 404 `{"error": "not an upload"}`; a real
    upload path returns the image bytes.
48. `cd app/web && bun run check` exits 0 with the new core files (`init.ts` +
    test, `mask.ts` + test with `mask.ts` pinned in `fr-audit.ts`);
    `app/static/create.js` stays ≤ 100 KB.
49. AUTO aspect (§5.1a): with no attachment the ASPECT row's AUTO chip is
    disabled (dimmed, title `attach an image to size the canvas from it`);
    attaching an image enables it once the upload lands. Selecting AUTO and
    submitting with a 1920×1080 image at FULL + LIMITED creates a session whose
    config shows `width: 680, height: 384` (the optimistic tile renders at the
    same AR); the same submit at VQGAN shows `width: 688, height: 384`
    (stride-16 rounding — dims the engine renders exactly).
50. With AUTO selected, removing the attachment (chip ✕ or clearing the bar)
    visibly moves the ASPECT selection back to `1:1`; re-opening the popover
    shows AUTO disabled again.
51. TWEAK on an AUTO-submitted session rematerializes ASPECT and SIZE as
    CUSTOM (never AUTO — §5.3): re-submitting untouched replays the base dims
    verbatim; once the rematerialized chip's thumb has loaded, AUTO is
    selectable again and re-derives from the base image's dims.

Items 52–54 (the EXPERIMENTS panel, §5.7 — continues the same list):

52. The gear shows `▸ EXPERIMENTS` collapsed under SEED; clicking it rotates the
    chevron and reveals exactly six rows — INIT NOISE (WHITE/PINK/GRAY),
    PYRAMID (3/2/4/OFF), COHERENCE, FULL VISION, PHASE SCHEDULE, AUTO-STOP
    (OFF/ON each); it stays expanded across popover close/reopen within the
    session and starts collapsed after a reload.
53. ⚑ An untouched panel submits the byte-identical pre-panel payload (network
    panel: `coarse_to_fine: true, coarse_stages: 3` and NO other experiment
    keys). Selecting PINK adds exactly `init_spectrum: 'pink'` +
    `init_spectrum_chroma: 'natural'`; PYRAMID OFF removes the c2f pair; each
    ON toggle adds exactly its own key (`coherence_weighting` /
    `cutout_sampler: 'full'` / `phase_scheduling` / `auto_stop`); flipping back
    to a default removes it again.
54. With an attachment, toggling ◈ HOLD on visibly moves the PYRAMID selection
    to OFF and disables the row (title names the engine refusal); HOLD off
    re-enables it still on OFF. TWEAK on a session with experiment values
    rematerializes the matching chips (off-menu values — e.g. a bench
    `coarse_stages: 5` — show CUSTOM and replay verbatim untouched).
