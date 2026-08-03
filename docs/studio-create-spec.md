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

No other server change. Explicitly out of scope: combined create-and-start
endpoint (inventory §2b — the PUT→POST pair is the design), archive/soft-hide,
prompt in SSE payloads.

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
      presets.ts            # aspect/quality/look/seed tables; resolveDims;
                            #   composeDraft; matchPresets (reverse map)   [+ .test.ts]
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
      lightbox.ts           # makeReelSource(tile); scrub transitions (pin/follow rule);
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
      renderLightbox.ts     # stage double-buffer, reel strip, actions row
      renderTop.ts          # toplayer root: orderSurfaces -> confirm / toast render
```

Rules of the split, applied:

- **Freerange core** (pure, testable without a browser): the preset tables and
  draft composition, the reverse preset match, tile/state derivations, every
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

// At most ONE pending creation exists at a time (single-slot queue).
type Pending =
  | { kind: 'posting'; prompt: string; sizeX: number; sizeY: number }
  | { kind: 'queued'; id: string; prompt: string; sizeX: number; sizeY: number }
  | { kind: 'starting'; id: string; prompt: string; sizeX: number; sizeY: number;
      deadline: number }  // wake-loop drops it if no SSE 'state' arrives by deadline

type AspectId = '1:1' | '3:4' | '4:3' | '16:9'
type QualityId = 'draft' | 'standard' | 'deep'
type LookId = 'limited' | 'unlimited' | 'vqgan'
type SeedMode = { kind: 'random' } | { kind: 'locked'; seed: number }

type Composer = {
  prompt: string
  // null = "inherit tweak base" — reachable ONLY while tweak != null (a fresh
  // composer always has concrete ids). Renders as a CUSTOM chip in the popover.
  aspect: AspectId | null
  quality: QualityId | null
  look: LookId | null
  seedMode: SeedMode
  tweak: { of: string; baseValues: Record<string, unknown> } | null
  popoverOpen: boolean
}

type Lightbox = {
  sessionId: string
  frame: number | 'follow'       // 1-based; 'follow' tracks tile.frames live
  swipe: { direction: SwipeDirection; accumulated: number }   // reel-strip machine
  anchor: { x: number; y: number; sizeX: number; sizeY: number }  // tile rect at open,
                                 // copied from the masonry cursor (never re-measured)
}

type CreateState = {
  boot: { phase: 'loading' } | { phase: 'ready' } | { phase: 'failed'; message: string }
  env: Env                                        // kit/env snapshot
  draftFields: string[]                           // schema field-name whitelist (§5.2)
  tiles: Tile[]                                   // newest-first (server order preserved)
  pending: Pending | null
  queue: { id: string; slug: string } | null      // server-truth mirror, SSE-driven
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
- No field mirrors another. `queue` mirrors the server slot; `pending` is Create's
  own submission lifecycle; they reference each other by id only.
- Tile identity keys everything (DOM node map, springs, anchor pin) — never
  view-tree position.

---

## 5. Preset tables (`core/presets.ts`)

### 5.1 The tables — exact values, exhaustive

Quality picks the size class and step count; aspect picks the shape within the
class. `resolveDims(aspect, quality)` is a pure table lookup:

| aspect | Draft (256-class) | Standard / Deep (512-class) |
|---|---|---|
| `1:1`  | 256 × 256 | 512 × 512 |
| `3:4`  | 224 × 288 | 448 × 576 |
| `4:3`  | 288 × 224 | 576 × 448 |
| `16:9` | 320 × 180 | 640 × 360 |

| quality | steps_per_scene | class |
|---|---|---|
| `draft` | 150 | 256 |
| `standard` | 200 | 512 |
| `deep` | 300 | 512 |

| look | `image_model` value |
|---|---|
| `limited` | `Limited Palette` |
| `unlimited` | `Unlimited Palette` |
| `vqgan` | `VQGAN` |

Popover display labels: `1:1 · 3:4 · 4:3 · 16:9`; `DRAFT · STANDARD · DEEP`;
`LIMITED · UNLIMITED · VQGAN`; `SEED ⚄ RANDOM / 🔒 <n>`.

Fresh composer defaults: `1:1`, `standard`, `limited`, random seed.

### 5.2 `composeDraft(composer): { values, forkOf, seedLocked }`

The server draft PUT is **replace-relative-to-defaults** (verified: `read_draft`
merges stored values over fresh defaults; inventory §1.3). Create exploits that:
send only the overrides, everything else falls back to schema defaults +
`config/default.yaml` curation.

- Fresh (tweak == null):
  `values = { scenes: prompt, width, height, steps_per_scene, image_model }`
  plus `seed` iff `seedMode.kind === 'locked'`; `forkOf: null`;
  `seedLocked: seedMode.kind === 'locked'`.
- Tweak (tweak != null):
  `values = { ...tweak.baseValues, ...overrides, scenes: prompt }` where
  `overrides` includes width/height/steps only for **non-null** aspect/quality,
  `image_model` only for non-null look, and seed per seedMode. `forkOf: tweak.of`.
- `tweak.baseValues` is built by `draftableValues(config, draftFields)`: keep only
  keys present in the schema field whitelist (`Object.keys(schema.fields)` fetched
  at boot). This is parse-at-the-boundary: a snapshot key the draft PUT would 400
  on (e.g. anything non-schema) never leaves the client.

Deliberate consequence (do not "fix"): Create's Enter **overwrites the shared
server draft**. The draft is a single-user resource and this is the inventory §2b
design. A bench tab open at the time keeps its in-memory draft until its own next
save; that is existing bench behavior, out of scope.

### 5.3 `matchPresets(values): { aspect, quality, look }` (reverse map, for Tweak)

Exact-match only: `(width,height)` against the dims table → aspect + class;
`steps_per_scene` ∈ {150,200,300} AND its class matches the dims class → quality;
`image_model` against the look table → look. Any miss → `null` for that control
(renders as `CUSTOM`, inherits base on submit). No nearest-neighbor guessing.

### 5.4 Seed control

Two-state toggle. `random` → the draft omits `seed`, `seedLocked: false`, server
rolls fresh (verified, inventory §1.9). Toggling to `locked` pins, in priority
order: the tweak base's seed, else `state.lastSeed`, else a fresh `uint32` rolled
in the **dom** layer (the one `Math.random` in the app — core receives it as
data). The pinned value is displayed read-only next to the toggle. Re-pinning =
toggle random → locked again. Every POST response's `seed` updates
`state.lastSeed`.

### 5.5 Image input

§15.6 amends `composeDraft`/`matchPresets` with the init-image fields
(`init_image`, `direct_init_weight`, `semantic_init_weight`, `perceptor_backend`),
emitted **only** when an image is attached.

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
2. `PUT /api/draft` with `composeDraft(composer)`. Non-204 → parse `{error}`,
   toast it, `pending = null`, stop.
3. `POST /api/sessions {"mode": "queue"}` — Create always uses `queue` (idle →
   starts immediately; busy → the one-slot queue). **Never `preempt` from
   Create** — killing a live render is a bench verb.
   - `201 {sessionId, seed}` → `pending = { kind: 'starting', id: sessionId, …,
     deadline: now + feel.startingGraceMs }`; `lastSeed = seed`; set `lastRun`.
   - `202 {queued, replaced}` → `pending = { kind: 'queued', id: queued, … }`;
     set `lastRun`; if `replaced` → toast `replaced queued render`.
   - `400 {error: "preflight failed", issues}` → toast the first
     `severity === 'error'` issue's `message` (prefixed by its `field`);
     `pending = null`.
4. Composer keeps its prompt (Midjourney grammar: the bar retains text). Tweak
   mode persists until the user clears the bar (which resets `tweak = null` and
   restores concrete preset ids) or submits — after a tweak submit, `tweak` stays
   (iterating on the same base), matching MJ remix.

**A2 — Cmd+Enter (re-run last), global.**
Guard: `lastRun != null` (else toast `nothing to re-run`). Replays `lastRun`
verbatim: optimistic tile → `PUT /api/draft` (lastRun payload) → `POST
{"mode":"queue"}` with the same result handling as A1. (A random-seed lastRun
rolls a new seed server-side — "re-run" means same settings, not same pixels.)

**A3 — Re-run (lightbox action on session S): same settings, fresh seed.**
1. Ensure `tile.detail` (fetch `GET /api/sessions/{S}` if null; cache).
2. `values = draftableValues(detail.config, draftFields)`.
3. `PUT /api/draft {values, forkOf: S, seedLocked: false}` →
   `POST {"mode":"queue"}` (A1 result handling). Lightbox stays open; the new
   tile appears in the gallery behind it.

**A4 — Tweak (lightbox action on session S): prefill bar + popover.**
1. Ensure `tile.detail` as in A3.
2. `composer.prompt = String(config.scenes)`; `composer.tweak = { of: S,
   baseValues: draftableValues(config) }`; `{aspect, quality, look} =
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

**A8 — Cancel queued (× on the queued tile).**
`DELETE /api/queue` → 204 → `pending = null` immediately (the `queue {queued:
null}` SSE echo is then a no-op, §6.2 Q-rule).

**A9 — Open lightbox.** Click a session tile with `frames >= 1` (0-frame tiles
ignore clicks — nothing to show). `lightbox = { sessionId, frame:
state === 'rendering' ? 'follow' : tile.frames, swipe: still, anchor: <copied
cursor rect> }`. The anchor rect is **copied from the masonry cursor during the
emit walk** (stored per-tile in the DOM node map at placement time) — never
measured from the DOM.

**A10 — Scrub.** Wheel over the lightbox drives the reel-strip swipe machine
(§8). `←`/`→` step one frame. Clicking a strip thumb jumps to it. Setting frame
to `tile.frames` while the session renders → `'follow'` (pin releases at the
newest frame). Any backward step pins.

**A11 — Popover.** Gear button toggles; outside-click and Esc close. Popover
edits mutate `composer` only — **no network on popover interaction** (no draft
PUT until submit; live estimates via `/api/preflight` are deliberately not on the
Create surface).

**A12 — `/`** focuses the bar (unless focus is already in an input). Esc with no
surface open blurs the bar.

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
| `queue` | `state.queue = payload.queued`. Reconciliation rules (**Q-rules**): (1) `queued == null` && `pending?.kind === 'queued'` → `pending` becomes `{ kind: 'starting', deadline: now + feel.startingGraceMs }` — the slot draining normally precedes `state: launching` (inventory gotcha 5); the wake loop drops the tile at the deadline if no `state` event claimed it (covers "cleared from another tab"). (2) `queued != null` && `pending?.kind === 'queued'` && ids differ → ours was replaced externally → `pending = null`, toast. (3) `queued != null` && `pending == null` → queued from the bench: `pending = { kind: 'queued', id, prompt: slug, sizeX: 512, sizeY: 512 }` (slug is the only text the slot carries). |
| `encode` | `state.download?.jobId === payload.jobId` → update `framesDone/framesTotal`; on `done` → trigger `<a download>` of `outUrl`, `download = null`, `GET /api/sessions/{sessionId}` to refresh `artifacts`; on `failed`/`cancelled` → toast, `download = null`. Other jobs' events: ignored. |
| `log` | Ignored. The Create surface has no log chrome; the bench renders logs. |

### 6.3 Boot, reconnect, resync

- **Boot** (`dom/main.ts`): `Promise.all` of `GET /api/schema` (only
  `Object.keys(fields)` is kept → `draftFields`), `GET /api/sessions`,
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
  | { kind: 'session'; tile: Tile }

// Rebuilt each render (derived, ephemeral — recompute over cache):
//   [pending?, ...tiles]  — pending first, tiles already newest-first.
function deriveGallery(state: CreateState): GalleryEntry[]

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
| pending `queued` | as posting + `QUEUED` chip + `×` cancel (A8) |
| pending `starting` | as posting + `STARTING` chip, no cancel |
| session `rendering` / `launching`/`loading_models` substate | skeleton shimmer (0 frames) or latest thumb; substate label (`warming up…` / `loading models…`); indeterminate bar |
| session `rendering` / `rendering` substate | latest thumb, swaps on every `frame` event; bottom progress bar `step/stepsTotal`; thin cyan pulse |
| session `rendering` / `stopping` | as above + `STOPPING` chip, bar frozen |
| session `done` | newest thumb; no chrome until hover |
| session `stopped` | newest thumb; small `◼ n frames` chip |
| session `failed` | thumb if `frames > 0` else dark slab; `FAILED` chip (danger); hover footer shows `failExcerpt` first line |
| session `imported` | newest thumb; `IMPORTED` chip on hover |

Thumb `src` = `thumbUrl(id, frames)`; skeleton shows until the `<img>` `load`
event (load state lives in the node cache, not app state). `frames === 0` →
placeholder, no request.

---

## 8. Lightbox — kit/reel-strip

### 8.1 Source and navigation

```ts
// core/lightbox.ts — one group: the session; items: its frames 1..N
function makeReelSource(tile: Tile): ReelSource<Tile> {
  return {
    groups: [tile],
    isGroupHidden: () => false,
    itemCount: () => tile.frames,
    isItemHidden: () => false,
    isItemHardHidden: () => false,
  }
}
```

`ItemRef.item` is 0-based; frame indices are 1-based (`frame = item + 1`) — the
conversion lives in `core/lightbox.ts` only, asserted at the boundary.

- Wheel: `swipeStep(direction, accumulated, deltaY, next, prev,
  mjFeel.swipeThreshold)` with `next = reelNext(source, ref)`, `prev =
  reelPrev(source, ref)`. Navigate result → set `frame` (pin/follow rule from
  A10). Swipe state persists in `lightbox.swipe`.
- Strip: vertical, right edge. `reelAnchorScan(source, stripCenterY,
  mjFeel.itemSize = 56, mjFeel.groupGapY = 8, anchorRef)` yields positions;
  `anchorMorph(accumulated, threshold, mjFeel.anchorSize = 68, itemSize)` sizes
  the focused vs incoming thumbs mid-swipe; `anchorTravelY` moves the focused
  thumb. Strip thumbs use `thumbUrl(id, frame)`.
- Long sessions: the strip renders only thumbs whose scan y falls in the strip
  viewport (the scan's positions are already y-ordered; slice by band).

### 8.2 Stage, open/close, chrome

- Stage image: `frameUrl(id, frame === 'follow' ? tile.frames : frame)`, PNG,
  double-buffered (two `<img>`, swap on `load` — never blanks; bench stage
  precedent). Preload `frame ± 1`.
- **Open morph**: spring-driven FLIP from `lightbox.anchor` (the copied masonry
  rect, A9) to the fitted stage rect (`fit(aspect, stageX, stageY)` from
  kit/midui). One `Spring` per axis-pair (x, y, sizeX, sizeY) stepped on the
  fixed 6 ms timestep (`springStepCount` guard); scrim opacity tracks the size
  spring's progress. Close reverses to the tile's **current** placement rect (re-
  copied at close time from the node cache — the tile may have moved). If the
  tile was evicted (scrolled far), fall back to a centered fade. Reduced motion
  (`env.reducedMotion`) → `springGoToEnd` immediately.
- Chrome (bottom band): full `scenes` text (1 line, ellipsis, click-to-expand to
  3 lines), params line, actions row. Params line from summary data immediately —
  `512×512 · 200/200 steps · seed 1234 · frame 12/30` — and gains the model name
  (`· Limited Palette`) once `tile.detail` resolves (fetched on open, §4
  `detail`). Skeleton dashes while loading.
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
                          ┌─────────────────▼──────────────────┐
                          │ ASPECT   [1:1] [3:4] [4:3] [16:9]  │
                          │ QUALITY  [DRAFT] [STANDARD] [DEEP] │
                          │ LOOK     [LIMITED] [UNLTD] [VQGAN] │
                          │ SEED     [⚄ RANDOM] [🔒 3982117]   │
                          └────────────────────────────────────┘
   segmented chips, one selected per row — nothing else, ever.
   Tweak mode may show [CUSTOM] as the selected chip on a row (§5.3).
```

### 10.3 Tile states (gallery)

```
 posting/queued              rendering                    failed
┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐          ┌──────────────┐          ┌──────────────┐
│ ▒▒shimmer▒▒▒ │          │              │          │   dark slab  │
│  "infinite   │          │  live thumb  │          │              │
│   fractal…"  │          │              │          │  ✕ FAILED    │
│ QUEUED     × │          │ warming up…  │          │              │
└╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘          │━━━━━━╸ 62%   │          └──────────────┘
 dashed border            └──────────────┘           hover: failExcerpt
                           bar = step/stepsTotal
 done (hover)
┌──────────────┐
│              │
│    thumb     │
│░░░░░░░░░░░░░░│ ← hover footer: "infinite fractal mush… · 30f · 4m12s"
└──────────────┘
```

### 10.4 Lightbox (kit/reel-strip)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ████████████████████████████ scrim ████████████████████████████████████████│
│                                                                      ┌───┐ │
│                ┌───────────────────────────────┐                     │ ▪ │ │
│                │                               │                     │ ▪ │ │
│                │                               │                     ├───┤ │
│                │         frame 12 / 30         │                     │▐█▌│ │ ← focused 68px
│                │        (PNG, dbl-buffer)      │                     ├───┤ │    (anchorMorph)
│                │                               │                     │ ▪ │ │
│                │                               │                     │ ▪ │ │ ← strip 56px thumbs
│                └───────────────────────────────┘                     └───┘ │
│                                                                            │
│  infinite fractal mushroom forest | bioluminescent mycelium network | …    │
│  512×512 · 200/200 steps · Limited Palette · seed 3982117 · frame 12/30    │
│  ⟳ RE-RUN   ✎ TWEAK   ⚙ ADVANCED   ↓ DOWNLOAD   ✕ DELETE                   │
└────────────────────────────────────────────────────────────────────────────┘
  wheel = scrub (swipe machine) · ←/→ = step · Esc = close (morph back to tile)
  live session: follows newest frame; any back-scrub pins; scrub-to-end refollows
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
Draft/1:1 so each finishes in ~1 minute on this machine.

1. `GET http://127.0.0.1:7911/` serves the Create shell; no console errors on
   load; the gallery shows existing sessions (or the §10.6 empty state on a
   fresh outputs dir).
2. `GET /bench.html` serves the full existing bench — library rail, stage,
   bench column all functional, no console errors, no behavior differences.
3. With at least one session present, `/bench.html#s=<that id>` boots the bench
   with that session staged (stage header shows its id).
4. On Create, pressing `/` focuses the prompt bar; typing echoes without caret
   jumps; Esc blurs.
5. ⚙ opens the settings popover with a spring; it contains exactly four rows —
   aspect (4 chips), quality (3), look (3), seed toggle — and nothing else;
   outside-click and Esc close it.
6. Type a prompt, Enter: an optimistic tile appears at the top-left **in the
   same frame** (before any network response — verify via throttled network),
   then transitions through `warming up…`/`loading models…` into a live
   progress bar.
7. ⚑ During the render, the tile's image updates at least twice (SSE `frame`
   events swapping the derived thumb URL), and the progress bar advances.
8. ⚑ On completion the tile settles to its newest thumb with no chrome; hover
   shows the one-line footer with the prompt text.
9. Popover 16:9 + Standard, submit: the finished session's params line in the
   lightbox reads `640×360 · 200/200 steps`. Draft + 1:1 reads
   `256×256 · 150/150 steps`.
10. Seed: two consecutive submits with seed RANDOM and identical prompt produce
    different seeds (params lines differ). Toggle seed LOCKED (a number
    appears), submit twice: both sessions show that same seed.
11. ⚑ Submit while a render is live: the new tile shows `QUEUED` with an ×.
    Submitting again while queued replaces it (toast `replaced queued render`;
    still exactly one queued tile).
12. Clicking × on the queued tile removes it (`GET /api/queue` on 7911 returns
    `{"queued": null}`).
13. ⚑ A queued tile auto-starts when the live render finishes — it becomes a
    rendering tile without any page interaction.
14. Masonry: resizing the window changes the column count (2–5); no
    overlapping tiles at any width; tiles keep their aspect ratios.
15. While scrolled down the gallery, a new session prepending does not shift
    the viewport (scroll anchoring).
16. Thumbs show a shimmer skeleton until loaded; layout does not reflow when
    images arrive.
17. Clicking a finished tile opens the lightbox with a morph from the tile's
    rect; Esc morphs it back to the same tile.
18. Lightbox: mouse wheel scrubs frames (strip's focused thumb grows/shrinks
    through the swipe); `←`/`→` step exactly one frame; clicking a strip thumb
    jumps to it; the counter reads `frame i/N` correctly (1-based, N = frames).
19. ⚑ Opening the lightbox on a rendering session follows the newest frame as
    it lands; scrubbing backward pins; scrubbing forward to the newest frame
    resumes following.
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

Items 33–48 (image input + mask, §15) continue this list in §15.11. Item 5's
"exactly four rows" holds only while no image is attached — see §15.5.

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
  silent state changes).
- `direct_init_weight` / `semantic_init_weight` are `str` weight expressions
  (lines 52–53, default `""`). Weight fields support the `weight_mask` grammar
  (`prompt_spec.py` `parse_weight_spec` line 145 / `parse_mask_token` line 119):
  `"<weight>_[<abs path>]"`, with a `-` **inside the bracket** prefixing the path
  for inversion — `"0.3_[-/abs/mask.png]"` (line 126–128). A third `_` field is a
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
type InitStrengthId = 'subtle' | 'medium' | 'strong'   // 0.15 / 0.3 / 0.6

type InitImage =
  | { kind: 'uploading'; name: string; localUrl: string }
  | { kind: 'ready'; name: string; path: string; localUrl: string | null }
    // localUrl: object URL when attached this session (created/revoked by dom —
    //   it enters core as boundary data, like `now`); null when rematerialized
    //   from a tweak base (display goes through uploadUrl(path), §15.8)

type InitMask = { path: string; inverted: boolean }    // abs path of the mask PNG upload

type InitAttachment = {
  image: InitImage
  strength: InitStrengthId | null   // null = CUSTOM — inherit the base's weight
                                    //   expression; reachable ONLY while tweak != null
                                    //   (mirrors aspect/quality/look, §4)
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
null }` → the chip renders this frame → `uploadFile(...)`. On `200` → `image =
{ kind: 'ready', path, name, localUrl }`. On any failure (non-200, network) →
toast `parseErrorBody` (or `upload failed`), `composer.init = null`, revoke the
object URL (ruling 6). Attaching while a chip exists **replaces** it (old object
URL revoked, mask cleared — a new image invalidates a mask painted on the old
one).

**Chip anatomy** (in the bar, between the input and ⚙): `[28px thumb] MASK ✕`.
Thumb from `localUrl` (fresh) or `uploadUrl(path)` (rematerialized). `✕` →
`composer.init = null` — clears chip, mask, and INIT row in one gesture
(ruling 6). `MASK` opens the paint surface (§15.7); it is disabled while `image.
kind === 'uploading'`, when the thumb failed to load (§15.8), or when the tweak
base's weight is opaque (§15.6). A saved mask renders the affordance as
`MASK ✓`.

**A1 guard addition**: submitting while `init.image.kind === 'uploading'` →
toast `image still uploading`, no optimistic tile, stop. **Bar-clear rule
extension** (A1 step 4): clearing the bar resets the *whole* composer — tweak
AND attachment (chip, mask, INIT row) — so `strength: null` stays unreachable
outside tweak mode, mirroring the aspect/quality invariant.

### 15.5 INIT row (settings popover — amends §10.2 and checklist item 5)

The row exists **iff** `composer.init != null` (the popover has four rows
without an attachment, five with — item 5 is amended accordingly):

```
   ┌─────────────────────────────────────────────┐
   │ ASPECT   [1:1] [3:4] [4:3] [16:9]           │
   │ QUALITY  [DRAFT] [STANDARD] [DEEP]          │
   │ LOOK     [LIMITED] [UNLTD] [VQGAN]          │
   │ SEED     [⚄ RANDOM] [🔒 3982117]            │
   │ INIT     [SUBTLE] [MEDIUM] [STRONG]  ◈ HOLD │
   │          torch engine                       │  ← note, only while HOLD is on
   └─────────────────────────────────────────────┘
```

- Strength chips map to `direct_init_weight` `0.15 / 0.3 / 0.6`; **medium is the
  default** on attach. In tweak mode the row may show `[CUSTOM]` selected
  (`strength: null`, §15.6) — same convention as §5.3.
- `◈ HOLD` ("hold meaning") toggle: **on** → the submission carries
  `semantic_init_weight: '0.3'` **and pins `perceptor_backend: 'torch'`**, and
  the row shows a small dim `torch engine` note. **Off** → it pins *nothing* —
  neither key is emitted; the backend rides the default (fresh) or the tweak
  base (tweak).
- Popover edits still touch `composer` only — no network (A11 unchanged).

### 15.6 `composeDraft` changes (`core/presets.ts` + `core/init.ts`)

`ComposerDraftInput` gains `init: InitDraftInput | null`:

```ts
type InitDraftInput = {
  path: string                     // image.kind must be 'ready' (A1 guard, §15.4)
  strength: InitStrengthId | null
  holdMeaning: boolean
  mask: InitMask | null
}
```

`DraftPayload` is unchanged in shape — the init fields ride inside `values`.

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
  `direct_init_weight`, `semantic_init_weight` from `values` (the draft merge
  restores schema defaults — same mechanism as random-seed's `delete`).
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
`deriveInitFromBase(baseValues)` (§15.8). `composerDims` is unaffected (an init
never changes dims).

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
`draftableValues` and ride A3/A2 **verbatim with zero new code**: Re-run and
Cmd+Enter replay the init exactly (only the seed differs on A3, per its design).

**A4 (Tweak) gains one step** — after `matchPresets`, derive the attachment
(`core/init.ts deriveInitFromBase(baseValues) -> InitAttachment | null`):

- `init_image` empty → `init = null` (no chip). Else chip with `image = { kind:
  'ready', path, name: basename, localUrl: null }` — thumb via
  `uploadUrl(path)`.
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
| tweak-base image not an upload | thumbless chip, MASK disabled; weight rides verbatim (§15.8) |
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
36. ⚑ Submit with an attached image at MEDIUM: `GET /api/draft` (7911) shows
    `init_image` = the absolute upload path and `direct_init_weight` `"0.3"`,
    and **no** `semantic_init_weight` / `perceptor_backend` keys among the
    stored overrides; the render completes on the default backend and frame 1
    visibly starts from the attached image.
37. SUBTLE and STRONG submissions carry `direct_init_weight` `"0.15"` /
    `"0.6"` respectively (bench inspector on the created sessions).
38. ⚑ HOLD MEANING on: the INIT row shows the `torch engine` note; the
    submitted config has `semantic_init_weight` `"0.3"` **and**
    `perceptor_backend` `"torch"`; the render completes.
39. Submit with no image attached: the stored draft values contain none of
    `init_image` / `direct_init_weight` / `semantic_init_weight` (keys absent,
    not empty strings).
40. MASK opens the paint surface: image at fit size; PAINT tints the stroked
    region accent; ERASE removes it; the brush-size slider changes stamp
    diameter; CLEAR wipes; the header copy states painted = where the image
    holds.
41. ⚑ SAVE uploads a white-on-black PNG (`POST /api/uploads`, `mask-*.png`),
    closes the editor, and the chip reads `MASK ✓`; the submitted
    `direct_init_weight` is `0.3_[/abs/.../mask-*.png]`. With INVERT on, the
    bracket carries the leading `-`: `0.3_[-/abs/.../mask-*.png]`.
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
