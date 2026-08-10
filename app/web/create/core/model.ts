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
//   replaceInit(state, init)                    THE composer.init write path (dom's setInit
//                                               wraps it): clearing the attachment while
//                                               aspect === 'auto' reverts aspect to '1:1'
//                                               in the same transition (§5.1a — AUTO has
//                                               no referent without an attachment)
//   applyHoldMeaning(state, on)                 THE holdMeaning write path (§5.7): ON
//                                               forces experiments.pyramid to 'off' in
//                                               the same transition (the engine refuses
//                                               c2f + semantic init); OFF restores
//                                               nothing — the row re-enables where it
//                                               stands. Throws without an attachment
//   applyLook(state, look)                      THE composer.look write path (§5.7/§16):
//                                               VQGAN forces NOISE white + ANNEAL off
//                                               (codebook init; latent refusals) +
//                                               PROJECTION off + UNDERPAINT off (§16);
//                                               ANY look away from UNLIMITED forces
//                                               FOURIER off (its engine scope);
//                                               switching away restores nothing
//   applyAutoStop(state, autoStop)              THE experiments.autoStop write path
//                                               (§5.7): ON forces experiments.anneal to
//                                               'off' in the same transition (the
//                                               engine refuses annealing + auto_stop)
//                                               AND experiments.projection to 'off'
//                                               (§16 — projection edits break plateau
//                                               semantics); OFF restores nothing
//   applyProjection(state, toggle)              §16: ON forces ANNEAL off (one
//                                               between-steps intervention at a time)
//   applyFourier(state, toggle)                 §16: ON forces NOISE white + ANNEAL off
//                                               (the fourier scope); UNLIMITED look only
//   applyUnderpaint(state, id)                  §16: non-OFF forces PYRAMID off (the
//                                               finish must not run the pyramid)
//   applyAspect / applySize(state, id)          THE aspect/size write paths (§16): a
//                                               dims change that breaks the /8 stride
//                                               forces PROJECTION off (projectionDimsSafe)
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
import {
  type ComposerAspect,
  type Experiments,
  type LookId,
  projectionDimsSafe,
  type SeedMode,
  type SizeId,
  type ToggleId,
  type UnderpaintEnvelope,
  type UnderpaintId,
} from './presets'

export type SessionState = 'rendering' | 'stopped' | 'done' | 'failed' | 'imported'
export type TerminalState = 'done' | 'stopped' | 'failed'
// 'underpainting' (§16): phase 1 of a two-phase session is rendering — the tile's
// 'underpainting…' label; summaries collapse it to the 'rendering' SessionState.
export type Substate = 'launching' | 'loading_models' | 'rendering' | 'underpainting' | 'stopping'
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
  // §16: the two-phase envelope ({source, steps}) from the summary — null for normal
  // sessions. TWEAK rematerializes the UNDERPAINT row from it; RE-RUN replays it.
  underpaint: UnderpaintEnvelope | null
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
  // null = "inherit tweak base" — reachable ONLY while tweak != null. 'auto' (size to
  // the attachment's own AR, §5.1a) is reachable ONLY while init != null — replaceInit
  // models the revert half of that invariant.
  aspect: ComposerAspect | null
  size: SizeId | null
  // steps_per_scene verbatim (§5.1 — the biggest lever). Always a concrete validated
  // positive integer — no null-inherit: chips are shortcuts, the custom input takes
  // 1..MAX_CUSTOM_STEPS, and a tweak base rematerializes via rematerializeSteps (§5.3).
  steps: number
  look: LookId | null
  seedMode: SeedMode
  // baseUnderpaint (§16): the base session's envelope — the UNDERPAINT row's
  // CUSTOM (null) replay source, captured from the tile summary at tweak time.
  tweak: { of: string; baseValues: Record<string, unknown>; baseUnderpaint: UnderpaintEnvelope | null } | null
  init: InitAttachment | null // the image attachment (§15.3); strength null only in tweak
  // The EXPERIMENTS panel (§5.7): opt-in engine modes, one row per schema-field
  // mapping. Row nulls = inherit tweak base (CUSTOM), reachable only while
  // tweak != null — same convention as aspect/size/look.
  experiments: Experiments
  popoverOpen: boolean
  // The EXPERIMENTS disclosure's expanded/collapsed state — projection state like
  // popoverOpen (session-local, collapsed on load, persists across popover
  // open/close for the page's lifetime). NEVER read by composeSubmission — it is
  // not part of the submission payload (§5.7).
  experimentsOpen: boolean
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

export type LightboxSwipe = { direction: SwipeDirection; accumulated: number }

export type Lightbox = {
  sessionId: string
  frame: number | 'follow' // 1-based; 'follow' tracks tile.frames live
  // Two-axis navigation (§8): horizontal = frames within the job, vertical = jobs
  // (sessions with frames, gallery order). One swipe machine per axis; the dominant-axis
  // rule (core/lightbox dominantAxis) keeps at most ONE accumulator non-zero at a time —
  // a live gesture owns its axis until it decays to rest.
  swipeX: LightboxSwipe
  swipeY: LightboxSwipe
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
      renderPhase: 'underpaint' | 'main' // §16: which render of the session is ticking
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
  lastRun: {
    values: Record<string, unknown>
    forkOf: string | null
    seedLocked: boolean
    underpaint: UnderpaintEnvelope | null // §16 — Cmd+Enter replays the envelope too
  } | null
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

// The one write path for composer.init (every dom route — attach, chip ✕, bar clear,
// upload failure, tweak rematerialization — goes through main's setInit, which wraps
// this), so the 'auto' aspect invariant lives here: AUTO means "the attachment's AR",
// and without an attachment it has no referent — removing the chip visibly reverts the
// aspect to '1:1' (the fresh default) in the same transition, never leaving a silent
// dangling AUTO (§5.1a). A REPLACED attachment keeps AUTO: it re-derives from the new
// image's dims once they are known.
export function replaceInit(state: CreateState, init: InitAttachment | null): void {
  state.composer.init = init
  if (init == null && state.composer.aspect === 'auto') state.composer.aspect = '1:1'
}

// THE holdMeaning write path (§5.7 — dom's HOLD chip toggle and nothing else; tweak
// rematerialization re-asserts the same rule after deriveInitFromBase). The engine
// refuses coarse_to_fine + semantic init, so flipping HOLD on forces the PYRAMID row
// to OFF in the same transition — the selection visibly moves (the AUTO-aspect revert
// precedent, §5.1a: loud, never a silent dangling pair). Flipping HOLD off re-enables
// the row where it stands (OFF) — no silent restore; the user re-picks.
export function applyHoldMeaning(state: CreateState, on: boolean): void {
  const init = state.composer.init
  if (init == null) throw new Error('applyHoldMeaning without an attachment (the HOLD chip exists iff attached)')
  init.holdMeaning = on
  if (on) state.composer.experiments.pyramid = 'off'
}

// THE composer.look write path (§5.7 — dom's LOOK chips; tweak rematerialization
// re-asserts the same rule after matchPresets). The engine refuses shaped init noise
// AND structure annealing under VQGAN (a codebook draw has no spectrum to shape;
// annealing rejects latent models), so picking VQGAN forces the NOISE row to WHITE
// and the ANNEAL row to OFF in the same transition — both selections visibly move
// (the applyHoldMeaning precedent: loud, never a silent dangling pair; a null/CUSTOM
// row is forced too, since it would let base spectrum/anneal keys ride). Switching
// the look away re-enables both rows where they stand — no silent restore.
export function applyLook(state: CreateState, look: LookId): void {
  state.composer.look = look
  if (look === 'vqgan') {
    state.composer.experiments.noise = 'white'
    state.composer.experiments.anneal = 'off'
    // §16: manifold projection refuses latent canvases, and underpaint under a
    // VQGAN finish is out of v1 scope — both rows force OFF, loudly.
    state.composer.experiments.projection = 'off'
    state.composer.experiments.underpaint = 'off'
  }
  // §16 FOURIER × LOOK: fourier_parameterization is scoped to the Unlimited
  // Palette — ANY look away from UNLIMITED forces the row OFF (a null/CUSTOM row
  // would let base fourier keys ride under a model the engine refuses; a concrete
  // OFF re-pick clears them — FOURIER_FIELDS ownership).
  if (look !== 'unlimited') state.composer.experiments.fourier = 'off'
}

// THE experiments.autoStop write path (§5.7 — dom's AUTO-STOP chips; tweak
// rematerialization re-asserts the same rule after matchExperiments). The engine
// refuses structure_annealing + auto_stop (a plateau stop mid-cycle would freeze a
// half-liquid image), so turning AUTO-STOP ON forces the ANNEAL row to OFF in the
// same transition (null/CUSTOM included). The other direction is prevented, not
// forced: the ANNEAL chips are disabled while AUTO-STOP is ON (the pyramid × HOLD
// treatment). OFF restores nothing — the row re-enables where it stands.
export function applyAutoStop(state: CreateState, autoStop: ToggleId): void {
  state.composer.experiments.autoStop = autoStop
  if (autoStop === 'on') {
    state.composer.experiments.anneal = 'off'
    // §16: the engine refuses manifold_projection + auto_stop (a scheduled image
    // edit breaks plateau semantics) — AUTO-STOP dominates, PROJECTION yields.
    state.composer.experiments.projection = 'off'
  }
}

// THE experiments.projection write path (§16 — dom's PROJECTION chips; tweak
// rematerialization re-asserts). The engine refuses manifold_projection +
// structure_annealing (one between-steps intervention at a time), so turning
// PROJECTION ON forces the ANNEAL row to OFF in the same transition (null/CUSTOM
// included — base anneal keys must not ride). The reverse direction is prevented:
// the ANNEAL chips are disabled while PROJECTION is ON (the AUTO-STOP treatment).
// The VQGAN / auto-stop / dims preconditions are the chip's own disablement —
// renderBar keeps ON unreachable there, composeSubmission throws as the backstop.
export function applyProjection(state: CreateState, projection: ToggleId): void {
  state.composer.experiments.projection = projection
  if (projection === 'on') state.composer.experiments.anneal = 'off'
}

// THE experiments.fourier write path (§16 — dom's FOURIER chips; enabled only while
// LOOK is UNLIMITED). The engine pins fourier_parameterization to a white init
// spectrum (the Fourier init IS 1/f-shaped) and refuses structure_annealing
// (pixel-domain planes don't compose with a spectrum parameterization), so ON
// forces NOISE to WHITE and ANNEAL to OFF in the same transition; both rows'
// chips are disabled while FOURIER is ON. OFF restores nothing.
export function applyFourier(state: CreateState, fourier: ToggleId): void {
  state.composer.experiments.fourier = fourier
  if (fourier === 'on') {
    state.composer.experiments.noise = 'white'
    state.composer.experiments.anneal = 'off'
  }
}

// THE experiments.underpaint write path (§16 — dom's UNDERPAINT chips; tweak
// rematerialization re-asserts). A non-OFF underpaint forces the PYRAMID row to
// OFF in the same transition: the finish must run FLAT — coarse_to_fine's stage-1
// downsample would destroy the underpaint (the server strips c2f at the handoff
// as the backstop; the row must not lie, §5.6). The PYRAMID chips are disabled
// while UNDERPAINT is non-OFF. VQGAN disablement is applyLook's (v1 scope).
export function applyUnderpaint(state: CreateState, underpaint: UnderpaintId): void {
  state.composer.experiments.underpaint = underpaint
  if (underpaint !== 'off') state.composer.experiments.pyramid = 'off'
}

// THE aspect/size write paths (§16 — dom's ASPECT/SIZE chips route through these;
// replaceInit's AUTO-revert writes '1:1' directly, which is always /8-safe).
// Dims dominate PROJECTION: a change that breaks the /8 stride (the one table
// offender is draft 16:9's 320x180; tweak bases can carry anything) forces the
// PROJECTION row to OFF in the same transition — the §5.7 forcing doctrine, never
// a submit-time surprise.
export function applyAspect(state: CreateState, aspect: ComposerAspect): void {
  state.composer.aspect = aspect
  enforceProjectionDims(state)
}

export function applySize(state: CreateState, size: SizeId): void {
  state.composer.size = size
  enforceProjectionDims(state)
}

function enforceProjectionDims(state: CreateState): void {
  const composer = state.composer
  if (composer.experiments.projection !== 'on') return
  const base = composer.tweak == null ? null : composer.tweak.baseValues
  if (!projectionDimsSafe(composer.aspect, composer.size, base)) {
    composer.experiments.projection = 'off'
  }
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
  // §16: the tick's renderPhase implies the render substate — 'underpainting…'
  // vs the live bar — which matters on reconnect (REST only said 'rendering').
  const implied: Substate = ev.renderPhase === 'underpaint' ? 'underpainting' : 'rendering'
  const live = tile.live
  if (live == null) {
    // Reconnect case — a progress tick implies the substate.
    tile.live = {
      substate: implied,
      step: ev.step,
      stepsTotal: ev.stepsTotal,
      scene: ev.scene,
      sceneCount: ev.sceneCount,
      phase: ev.phase,
      sPerStep: ev.sPerStep,
      etaSec: ev.etaSec,
    }
  } else {
    // Telemetry fields ONLY (spec §6.2): launching/loading/stopping substates belong
    // to state events — a progress tick racing a stop request must not clobber
    // 'stopping' (the STOPPING chip stays). The one exception is the §16 phase
    // marker: a tick may flip BETWEEN the two render substates (a stale
    // 'underpainting' after a reconnect that landed mid-phase-2, and vice versa).
    if (live.substate === 'rendering' || live.substate === 'underpainting') live.substate = implied
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
