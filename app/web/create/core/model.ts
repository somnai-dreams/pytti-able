// @cs
// create/core/model: the CreateState type (the ONE store, spec §4) and every SSE-event ->
// state transition. Appliers take the store + a parsed event, apply the mutation the spec
// table (§6.2) prescribes, and return any required follow-up I/O as DATA (a FollowUp
// union the dom layer executes) — core never fetches.
//
// String/JSON domain — outside freerange's numeric subset; model.test.ts is the checked
// surface.
//
// types:
//   Tile, Pending, Composer, Lightbox, MaskEditor, CreateState … (spec §4 + §15.3)
//   SseEvent   — tagged union produced by core/api parseSseEvent
//   FollowUp   — 'none' | fetch-session (unknown id: fetch+insert) | fetch-fail-excerpt
//                | download-and-refresh (encode done)
//
// functions:
//   findTile(tiles, id) -> Tile | null          linear scan (flat array is the model)
//   insertTile(state, tile)                     insert by startedAt desc (replace same id);
//                                               clears pending when it claims pending.id
//   removeTile(state, id)                       + closes a lightbox showing it
//   showToast(state, text, now)                 expiresAt = now + feel.toastMs
//   openMaskEditor(state) -> boolean            §15.7 open transition: closes the popover;
//                                               false (no-op) without a ready attachment OR
//                                               while already open — re-entry must never
//                                               replace an editor holding unsaved strokes
//   dropUnreadableMask(state)                   §15.7: unreadable existing mask -> init.mask
//                                               = null in the same transition as the
//                                               'starting blank' toast, so the dead path
//                                               cannot ride an invert-only SAVE or submit
//   applyStateEvent(state, ev, nowEpoch) -> FollowUp
//   applyProgressEvent(state, ev)               telemetry fields only (substate belongs to
//                                               state events); unknown ids ignored
//   applyFrameEvent(state, ev)                  frames = savedTotal (thumb URLs derive)
//   applyQueueEvent(state, ev, now)             server list wins; a queued id clears a
//                                               'starting' pending it would shadow;
//                                               drained-head -> starting bridge (§6.2
//                                               Q-rules)
//   findQueueItem(items, id) -> QueueItem|null  linear scan, same shape as findTile
//   removeQueueItem(state, id) -> boolean       optimistic per-item cancel: splice +
//                                               renumber; false = already gone (the
//                                               caller skips the redundant DELETE);
//                                               the SSE echo re-asserts truth
//   applyEncodeEvent(state, ev, now) -> FollowUp
//   reconcileSessions(state, fresh)             fresh wins; live carries over for ids
//                                               still rendering; detail carries always;
//                                               closes lightbox/delete-confirm on dropped
//                                               ids (discard-mask survives a resync)
// @/cs
import type { SwipeDirection } from '@kit/reel-strip/core'
import type { Env } from '@kit/env/core'
import { feel } from './feel'
import type { InitAttachment } from './init'
import type { AspectId, LookId, QualityId, SeedMode } from './presets'

export type SessionState = 'rendering' | 'stopped' | 'done' | 'failed' | 'imported'
export type TerminalState = 'done' | 'stopped' | 'failed'
export type Substate = 'launching' | 'loading_models' | 'rendering' | 'stopping'
export type Phase = 'pre_animation' | 'interpolation' | 'scene'

export type Artifact = { name: string; bytes: number; fps: number | null; format: 'mp4' | 'prores' }

export type LiveTelemetry = {
  substate: Substate
  step: number
  stepsTotal: number
  scene: number
  sceneCount: number
  phase: Phase
  sPerStep: number
  etaSec: number
}

export type Tile = {
  id: string
  slug: string
  scenes: string | null // S1; null only for legacy imports without a snapshot
  state: SessionState
  seed: number | null
  startedAt: number
  endedAt: number | null
  frames: number // 1-based frame indices are 1..frames
  stepsDone: number
  stepsTotal: number
  sizeX: number // S1 width/height; legacy-null parses to 512x512 with legacyDims
  sizeY: number
  legacyDims: boolean
  forkedFrom: string | null
  imported: boolean
  artifacts: Artifact[]
  failExcerpt: string | null
  // Non-null only while state === 'rendering'; may be null WHILE rendering too (REST
  // only says "rendering" — telemetry arrives with the next SSE state/progress event).
  live: LiveTelemetry | null
  // Full immutable config snapshot, fetched lazily on first lightbox open; cached forever.
  detail: Record<string, unknown> | null
}

// Pending covers ONLY Create's own optimistic submission lifecycle: the in-flight POST
// ('posting') and the enqueue->launching handoff gap ('starting'). QUEUED tiles are not
// pending — they derive from `state.queue`, the server-truth FIFO mirror, directly.
export type Pending =
  | { kind: 'posting'; prompt: string; sizeX: number; sizeY: number }
  | {
      kind: 'starting'
      id: string
      prompt: string
      sizeX: number
      sizeY: number
      deadline: number // wake loop drops it if no SSE 'state' arrives by then
    }

// One queued render, as GET /api/queue and the queue SSE event carry it (enough to
// render a tile: prompt text, dims for masonry height, 1-based position for the badge).
// position is server-sent and index-verified at the parse boundary (parseQueue).
export type QueueItem = { id: string; position: number; prompt: string; sizeX: number; sizeY: number }

export type Composer = {
  prompt: string
  // null = "inherit tweak base" — reachable ONLY while tweak != null.
  aspect: AspectId | null
  quality: QualityId | null
  look: LookId | null
  seedMode: SeedMode
  tweak: { of: string; baseValues: Record<string, unknown> } | null
  init: InitAttachment | null // the image attachment (§15.3); strength null only in tweak
  popoverOpen: boolean
}

// The paint surface's control state (§15.7). The PIXELS are dom scratch beside the
// store (an offscreen canvas at image resolution), never state.
export type MaskEditor = {
  brushSize: number // px in view space, feel.maskBrushMin..Max
  mode: 'paint' | 'erase'
  inverted: boolean // initialized from init.mask?.inverted ?? false; '-' applied at compose
  dirty: boolean // any stroke/clear since open (drives the Esc confirm)
  saving: boolean // upload in flight; SAVE disabled meanwhile
}

export type Lightbox = {
  sessionId: string
  frame: number | 'follow' // 1-based; 'follow' tracks tile.frames live
  swipe: { direction: SwipeDirection; accumulated: number }
  // Tile rect at open, copied from the masonry cursor — never re-measured.
  anchor: { x: number; y: number; sizeX: number; sizeY: number }
}

export type SseEvent =
  | { kind: 'state-live'; sessionId: string; substate: Substate }
  | {
      kind: 'state-terminal'
      sessionId: string
      state: TerminalState
      seed: number | null
      summary: { steps: number; frames: number; elapsedSec: number }
    }
  | {
      kind: 'progress'
      sessionId: string
      step: number
      stepsTotal: number
      scene: number
      sceneCount: number
      phase: Phase
      sPerStep: number
      etaSec: number
    }
  | { kind: 'frame'; sessionId: string; savedTotal: number }
  | { kind: 'queue'; items: QueueItem[] }
  | {
      kind: 'encode'
      jobId: string
      sessionId: string
      framesDone: number
      framesTotal: number
      state: 'running' | 'done' | 'failed' | 'cancelled'
      outUrl: string | null
    }

export type CreateState = {
  boot: { phase: 'loading' } | { phase: 'ready' } | { phase: 'failed'; message: string }
  env: Env
  schemaFields: string[] // schema field-name whitelist
  tiles: Tile[] // newest-first (server order preserved)
  pending: Pending | null
  queue: QueueItem[] // server-truth FIFO mirror, SSE-driven; queued tiles derive from it
  composer: Composer
  lastRun: { values: Record<string, unknown>; forkOf: string | null; seedLocked: boolean } | null
  lastSeed: number | null // most recent seed returned by POST; seeds the locked toggle
  lightbox: Lightbox | null
  maskEditor: MaskEditor | null // §15.7; non-null implies composer.init != null
  confirm: { kind: 'delete'; sessionId: string } | { kind: 'discard-mask' } | null
  toast: { text: string; expiresAt: number } | null
  download: { jobId: string; sessionId: string; framesDone: number; framesTotal: number } | null
  sse: { phase: 'connecting' | 'open' | 'retrying' }
  scrollTop: number // gallery scroller input (masonry viewport)
  anchorPin: { key: string; prevY: number } | null // masonry scroll-anchor pair
  now: number // performance.now() at frame start
}

export type FollowUp =
  | { kind: 'none' }
  | { kind: 'fetch-session'; sessionId: string } // unknown id: GET, parse, insertTile
  | { kind: 'fetch-fail-excerpt'; sessionId: string } // failed: refresh summary fields
  | { kind: 'download-and-refresh'; sessionId: string; outUrl: string }

const NONE: FollowUp = { kind: 'none' }

export function findTile(tiles: readonly Tile[], id: string): Tile | null {
  for (const tile of tiles) {
    if (tile.id === id) return tile
  }
  return null
}

export function showToast(state: CreateState, text: string, now: number): void {
  state.toast = { text, expiresAt: now + feel.toastMs }
}

// §15.7 open transition. The false branches mirror disabled affordances (no attachment /
// still uploading -> the chip disables MASK) plus the re-entry guard: the MASK button can
// still be activated at open time (Space/Enter while it holds focus), and a re-open would
// replace the editor object — unsaved strokes wiped past the discard confirm.
export function openMaskEditor(state: CreateState): boolean {
  if (state.maskEditor != null) return false
  const init = state.composer.init
  if (init == null || init.image.kind !== 'ready') return false
  state.composer.popoverOpen = false // mutual exclusion by construction (§15.7)
  state.maskEditor = {
    brushSize: feel.maskBrushDefault,
    mode: 'paint',
    inverted: init.mask != null && init.mask.inverted,
    dirty: false,
    saving: false,
  }
  return true
}

// §15.7's fail-soft ('existing mask not readable — starting blank') completed at the state
// layer: the unreadable PNG's path must not stay on init.mask, or an invert-only SAVE or a
// clean close re-emits the dead path into the next submit. One transition — what the user
// sees (blank canvas, no mask) is what submits.
export function dropUnreadableMask(state: CreateState): void {
  if (state.maskEditor == null) throw new Error('dropUnreadableMask outside an open mask editor')
  const init = state.composer.init
  if (init == null) throw new Error('mask editor open without an attachment (unreachable by construction)')
  init.mask = null
}

// Insert by startedAt desc (the server list order); a tile with the same id is replaced
// in place. When the inserted tile is the one `pending` was tracking, the optimistic tile
// hands over to the real one in the same mutation — no frame with both or neither.
export function insertTile(state: CreateState, tile: Tile): void {
  const existingIndex = state.tiles.findIndex((t) => t.id === tile.id)
  if (existingIndex >= 0) {
    state.tiles[existingIndex] = tile
  } else {
    let at = state.tiles.length
    for (let i = 0; i < state.tiles.length; i++) {
      if (state.tiles[i]!.startedAt <= tile.startedAt) {
        at = i
        break
      }
    }
    state.tiles.splice(at, 0, tile)
  }
  const pending = state.pending
  if (pending != null && pending.kind === 'starting' && pending.id === tile.id) {
    state.pending = null
  }
}

export function removeTile(state: CreateState, id: string): void {
  const index = state.tiles.findIndex((t) => t.id === id)
  if (index >= 0) state.tiles.splice(index, 1)
  if (state.lightbox != null && state.lightbox.sessionId === id) state.lightbox = null
}

function freshLive(substate: Substate): LiveTelemetry {
  return { substate, step: 0, stepsTotal: 0, scene: 0, sceneCount: 0, phase: 'scene', sPerStep: 0, etaSec: 0 }
}

export function applyStateEvent(
  state: CreateState,
  ev: Extract<SseEvent, { kind: 'state-live' | 'state-terminal' }>,
  nowEpoch: number,
): FollowUp {
  const tile = findTile(state.tiles, ev.sessionId)
  if (tile == null) {
    // A session Create hasn't seen (queue promotion, another tab, resumed render):
    // the dom layer fetches its summary and insertTile clears a matching pending.
    return { kind: 'fetch-session', sessionId: ev.sessionId }
  }

  switch (ev.kind) {
    case 'state-live': {
      tile.state = 'rendering'
      tile.endedAt = null
      if (tile.live == null) tile.live = freshLive(ev.substate)
      else tile.live.substate = ev.substate
      const pending = state.pending
      if (pending != null && pending.kind === 'starting' && pending.id === ev.sessionId) {
        state.pending = null // the tile already exists; the SSE state claims it
      }
      return NONE
    }
    case 'state-terminal': {
      tile.state = ev.state
      tile.live = null
      tile.frames = ev.summary.frames
      tile.stepsDone = ev.summary.steps
      tile.seed = ev.seed
      tile.endedAt = nowEpoch
      const lb = state.lightbox
      if (lb != null && lb.sessionId === ev.sessionId && lb.frame === 'follow') {
        lb.frame = Math.max(1, ev.summary.frames) // freeze at the last frame
      }
      // failExcerpt is not in the event — refetch the summary for the error surface.
      return ev.state === 'failed' ? { kind: 'fetch-fail-excerpt', sessionId: ev.sessionId } : NONE
    }
  }
}

export function applyProgressEvent(state: CreateState, ev: Extract<SseEvent, { kind: 'progress' }>): void {
  const tile = findTile(state.tiles, ev.sessionId)
  if (tile == null) return // resync owns discovery; state events own insertion
  tile.state = 'rendering'
  const live = tile.live
  if (live == null) {
    // Reconnect case — REST only said 'rendering'; a progress tick implies the substate.
    tile.live = {
      substate: 'rendering',
      step: ev.step,
      stepsTotal: ev.stepsTotal,
      scene: ev.scene,
      sceneCount: ev.sceneCount,
      phase: ev.phase,
      sPerStep: ev.sPerStep,
      etaSec: ev.etaSec,
    }
  } else {
    // Telemetry fields ONLY (spec §6.2): substate belongs to state events — a progress
    // tick racing a stop request must not clobber 'stopping' (the STOPPING chip stays).
    live.step = ev.step
    live.stepsTotal = ev.stepsTotal
    live.scene = ev.scene
    live.sceneCount = ev.sceneCount
    live.phase = ev.phase
    live.sPerStep = ev.sPerStep
    live.etaSec = ev.etaSec
  }
  tile.stepsDone = ev.step
  tile.stepsTotal = ev.stepsTotal
}

export function applyFrameEvent(state: CreateState, ev: Extract<SseEvent, { kind: 'frame' }>): void {
  const tile = findTile(state.tiles, ev.sessionId)
  if (tile == null) return
  tile.frames = ev.savedTotal // newest thumb/frame URLs derive from frames
}

export function findQueueItem(items: readonly QueueItem[], id: string): QueueItem | null {
  for (const item of items) {
    if (item.id === id) return item
  }
  return null
}

// Optimistic per-item cancel (A8): remove and renumber locally before the DELETE; the
// SSE echo re-asserts the server list. Returns false when the id is already gone
// (double-click, races with the echo) so the caller can skip the redundant DELETE —
// a 404 from it would toast 'already started or was cancelled' for a cancel that worked.
export function removeQueueItem(state: CreateState, id: string): boolean {
  const index = state.queue.findIndex((item) => item.id === id)
  if (index < 0) return false
  state.queue.splice(index, 1)
  for (let i = index; i < state.queue.length; i++) state.queue[i]!.position -= 1
  return true
}

// The Q-rules (spec §6.2): the server list is truth — replace the mirror wholesale.
// The ONE derived transition: the head item draining is the auto-start handoff (server
// ordering: the queue publish precedes `state: launching`), so the drained head bridges
// into a 'starting' pending tile for the grace window instead of flickering out. A head
// removed by a cancel from elsewhere takes the same bridge — no state event ever claims
// it and the wake loop drops it at the deadline. Non-head removals are cancels by
// construction (only the head can start) and just disappear.
export function applyQueueEvent(state: CreateState, ev: Extract<SseEvent, { kind: 'queue' }>, now: number): void {
  const oldHead = state.queue.length > 0 ? state.queue[0]! : null
  state.queue = ev.items
  // The queue is truth the other way too: an id the server says is queued is not
  // 'starting' — its tile derives from the list and pending must not shadow it with a
  // duplicate (reachable when a cancelled head's number is re-minted for a new enqueue
  // inside the grace window).
  if (state.pending != null && state.pending.kind === 'starting' && findQueueItem(ev.items, state.pending.id) != null) {
    state.pending = null
  }
  if (oldHead == null) return
  if (findQueueItem(ev.items, oldHead.id) != null) return // still queued (append/renumber)
  if (findTile(state.tiles, oldHead.id) != null) return // its session already materialized
  const pending = state.pending
  if (pending != null && pending.kind === 'posting') return // an in-flight POST owns the slot
  state.pending = {
    kind: 'starting',
    id: oldHead.id,
    prompt: oldHead.prompt,
    sizeX: oldHead.sizeX,
    sizeY: oldHead.sizeY,
    deadline: now + feel.startingGraceMs,
  }
}

export function applyEncodeEvent(
  state: CreateState,
  ev: Extract<SseEvent, { kind: 'encode' }>,
  now: number,
): FollowUp {
  const download = state.download
  if (download == null || download.jobId !== ev.jobId) return NONE // other jobs: ignored
  switch (ev.state) {
    case 'running':
      download.framesDone = ev.framesDone
      download.framesTotal = ev.framesTotal
      return NONE
    case 'done': {
      state.download = null
      if (ev.outUrl == null) throw new Error('encode done without outUrl (parser guarantees it)')
      return { kind: 'download-and-refresh', sessionId: ev.sessionId, outUrl: ev.outUrl }
    }
    case 'failed':
      state.download = null
      showToast(state, 'encode failed', now)
      return NONE
    case 'cancelled':
      state.download = null
      showToast(state, 'encode cancelled', now)
      return NONE
  }
}

// Reconnect resync: fresh summaries win; live telemetry carries over only while the
// fresh summary still says rendering; detail carries always (snapshots are immutable).
// Surfaces keyed to an id absent from the fresh snapshot close with it (lightbox,
// confirm) — the "open surface => its tile exists" invariant is MODELED here, so a
// session deleted while we were disconnected can never leave the render loop throwing
// at renderLightbox's true-invariant backstop.
export function reconcileSessions(state: CreateState, fresh: Tile[]): void {
  for (const tile of fresh) {
    const prev = findTile(state.tiles, tile.id)
    if (prev == null) continue
    tile.detail = prev.detail
    if (tile.state === 'rendering' && prev.live != null) tile.live = prev.live
  }
  state.tiles = fresh
  if (state.lightbox != null && findTile(fresh, state.lightbox.sessionId) == null) state.lightbox = null
  // The confirm-close rule applies to 'delete' only — a discard-mask confirm has no
  // session and survives a resync (§15.3).
  if (state.confirm != null && state.confirm.kind === 'delete' && findTile(fresh, state.confirm.sessionId) == null) {
    state.confirm = null
  }
}
