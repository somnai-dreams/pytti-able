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
