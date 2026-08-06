// main.ts — the chassis (kit doctrine, chassis-notes composition): ONE plain state
// object; named event functions mutate it and scheduleRender (renderNow only for the
// prompt keystroke echo); a rafRenderLoop projects the whole state each frame; a
// createWakeLoop owns the two timed facts (toast expiry, starting-grace deadline) as
// deadlines-as-data; watchEnv is the sole environment read.
import { defaultEnv } from '@kit/env/core'
import { readEnv, watchEnv } from '@kit/env/dom'
import { msPerAnimationStep, springStepCount } from '@kit/midui/motion'
import { createWakeLoop } from '@kit/onestore/core'
import { rafRenderLoop } from '@kit/onestore/dom'
import { artifactUrl, uploadUrl } from '../core/api'
import { feel } from '../core/feel'
import {
  deriveInitFromBase,
  type InitAttachment,
  initNaturalDims,
  type InitStrengthId,
  type NaturalDims,
  toInitSubmitInput,
} from '../core/init'
import { keyIntent } from '../core/keys'
import { applyWheel, jumpToFrame, stepFrame } from '../core/lightbox'
import {
  applyEncodeEvent,
  applyFrameEvent,
  applyProgressEvent,
  applyQueueEvent,
  applyStateEvent,
  type CreateState,
  findQueueItem,
  findTile,
  type FollowUp,
  insertTile,
  openMaskEditor,
  reconcileSessions,
  removeQueueItem,
  removeTile,
  replaceInit,
  showToast,
  type SseEvent,
  type Tile,
} from '../core/model'
import { composeSubmission, composerDims, matchPresets, parseStepsId, type SubmissionPayload, submittableValues } from '../core/presets'
import { topmostDismissable } from '../core/surfaces'
import * as net from './net'
import { initBar, renderBar } from './renderBar'
import { initGallery, renderGallery, tileScreenRect } from './renderGallery'
import { initLightbox, lightboxCloseMorph, lightboxOpenMorph, renderLightbox } from './renderLightbox'
import { initMask, openMaskSurface, renderMask } from './renderMask'
import { initTop, renderTop } from './renderTop'

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el == null) throw new Error(`missing #${id}`)
  return el
}

// --- static shell elements
const barEl = mustGet('bar')
const promptEl = mustGet('prompt') as HTMLInputElement
const gearEl = mustGet('gear') as HTMLButtonElement
const goEl = mustGet('go') as HTMLButtonElement
const attachEl = mustGet('attach') as HTMLButtonElement
const fileInputEl = mustGet('file-input') as HTMLInputElement
const chipMaskEl = mustGet('chip-mask') as HTMLButtonElement
const popoverEl = mustGet('popover')
const sseEl = mustGet('sse-dot')
const scrollerEl = mustGet('gallery-scroll')
const canvasEl = mustGet('gallery-canvas')
const emptyEl = mustGet('empty-state')
const bootSkelEl = mustGet('boot-skel')
const bootFailEl = mustGet('boot-fail')
const bootFailMsgEl = mustGet('boot-fail-msg')
const lightboxEl = mustGet('lightbox')
const confirmEl = mustGet('confirm')
const toastEl = mustGet('toast')

// §15.7 focus containment: everything stacked beneath zMaskEditor. While the mask editor
// is open these go `inert` — the scrim only blocks pointers; inert also removes tab focus
// and keyboard activation (Shift+Tab to the prompt under the scrim used to reach the
// bar-clear branch; Tab-to-GO + Enter used to submit under the editor). The confirm and
// toast roots stay live: the discard-mask confirm sits ABOVE the editor.
const shellEls = [
  mustGet('advanced-link'),
  sseEl,
  mustGet('bar-wrap'), // bar + popover
  scrollerEl,
  emptyEl,
  bootSkelEl,
  bootFailEl,
  lightboxEl,
]

// --- the single state object
const state: CreateState = {
  boot: { phase: 'loading' },
  env: defaultEnv(),
  schemaFields: [],
  tiles: [],
  pending: null,
  queue: [],
  composer: {
    prompt: '',
    aspect: '1:1',
    size: 'full', // the retired 'standard' quality's pair: 512-class dims + 200 steps —
    steps: 200, //   the never-opened-gear payload is byte-identical (§5.1)
    look: 'limited',
    seedMode: { kind: 'random' },
    tweak: null,
    init: null,
    popoverOpen: false,
  },
  lastRun: null,
  lastSeed: null,
  lightbox: null,
  maskEditor: null,
  confirm: null,
  toast: null,
  download: null,
  sse: { phase: 'connecting' },
  scrollTop: 0,
  anchorPin: null,
  now: 0,
}

// --- per-frame scratch beside the store (never in it)
let wheelDelta = 0
let springAcc = 0
let lastFrameTime = performance.now()
let wasAnimating = false // did the previous frame schedule this one to continue motion?
let shellInert = false // last projected inert value (§15.7 containment)

// --- render: latest-state projection, springs on the fixed timestep
//
// Spring-time accounting is loop-domain state (mutable frame scratch beside the store —
// the kit/onestore precedent: loop-domain state sits outside freerange's analyzable
// subset, checked by behavior not analysis), so this regression fix lives here, not in
// core: springStepCount itself is spec-true. Two guards:
//   1. A frame that no live animation scheduled is a WAKE — the idle gap is not spring
//      time. Without the reset, lastFrameTime only advanced inside render frames, every
//      wake credited the whole idle gap to springAcc, and each following frame consumed
//      the 60-step cap: motion finished instantly (teleport).
//   2. A mid-animation stall (background tab, debugger pause) clamps the backlog to one
//      cap's worth: the animation teleports ONCE (springStepCount's stated intent), not
//      through seconds of max-step catch-up frames.
const loop = rafRenderLoop((now) => {
  state.now = now
  if (!wasAnimating) lastFrameTime = now // guard 1: wake — discard the idle gap
  springAcc += Math.max(0, now - lastFrameTime)
  lastFrameTime = now
  springAcc = Math.min(springAcc, feel.maxSpringStepsPerFrame * msPerAnimationStep) // guard 2
  const steps = springStepCount(springAcc, feel.maxSpringStepsPerFrame)
  springAcc -= steps * msPerAnimationStep

  // The wheel-swipe machine steps once per frame: this frame's accumulated wheel input,
  // or a zero-delta decay step while the accumulator eases back to rest.
  const lb = state.lightbox
  if (lb != null && (wheelDelta !== 0 || lb.swipe.accumulated !== 0)) {
    const tile = findTile(state.tiles, lb.sessionId)
    if (tile == null) throw new Error(`lightbox on unknown session ${lb.sessionId}`)
    state.lightbox = applyWheel(lb, tile, wheelDelta)
  }
  wheelDelta = 0

  bootSkelEl.style.display = state.boot.phase === 'loading' ? '' : 'none'
  bootFailEl.style.display = state.boot.phase === 'failed' ? '' : 'none'
  if (state.boot.phase === 'failed') bootFailMsgEl.textContent = state.boot.message

  // §15.7 containment, projected from state like everything else in this loop (the many
  // close paths — Esc, scrim, SAVE, REMOVE, discard confirm — all just null maskEditor).
  const editorOpen = state.maskEditor != null
  if (editorOpen !== shellInert) {
    shellInert = editorOpen
    for (const el of shellEls) el.inert = editorOpen
  }

  let animating = false
  if (renderBar(state, steps)) animating = true
  if (renderGallery(state, steps)) animating = true
  if (renderLightbox(state, steps)) animating = true
  if (renderMask(state, steps)) animating = true
  if (renderTop(state, steps)) animating = true
  if (state.lightbox != null && state.lightbox.swipe.accumulated !== 0) animating = true
  wasAnimating = animating
  if (animating) loop.scheduleRender()
})

// --- wake loop: the two timed facts, deadlines as data
const wake = createWakeLoop(
  (now) => {
    let changed = false
    if (state.toast != null && now >= state.toast.expiresAt) {
      state.toast = null
      changed = true
    }
    const pending = state.pending
    if (pending != null && pending.kind === 'starting' && now >= pending.deadline) {
      state.pending = null // no SSE state claimed it in time (cleared from another tab)
      changed = true
    }
    if (changed) loop.scheduleRender()
    let next: number | null = state.toast == null ? null : state.toast.expiresAt
    const p = state.pending
    if (p != null && p.kind === 'starting') next = next == null ? p.deadline : Math.min(next, p.deadline)
    return next
  },
  { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) },
  () => performance.now(),
  { set: (cb, ms) => window.setTimeout(cb, ms), clear: (id) => window.clearTimeout(id) },
)

function toastNow(text: string): void {
  showToast(state, text, performance.now())
  wake.invalidate()
  loop.scheduleRender()
}

// Expected-unreachable failures (network refusal mid-action, races with deletes): the
// UI recovers visibly via a toast AND the error still reaches the console unhandled —
// recovery must not silence a genuine bug.
function toastError(err: unknown): void {
  toastNow(err instanceof Error ? err.message : String(err))
  console.error(err)
}

// --- net glue

function triggerDownload(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function refreshSession(id: string): Promise<void> {
  const { tile, config } = await net.getSessionDetail(id)
  tile.detail = config
  const prev = findTile(state.tiles, id)
  if (prev != null && prev.live != null && tile.state === 'rendering') tile.live = prev.live
  insertTile(state, tile)
  loop.scheduleRender()
}

async function ensureDetail(tile: Tile): Promise<Record<string, unknown>> {
  if (tile.detail != null) return tile.detail
  const { config } = await net.getSessionDetail(tile.id)
  tile.detail = config
  loop.scheduleRender()
  return config
}

function runFollowUp(follow: FollowUp): void {
  switch (follow.kind) {
    case 'none':
      return
    case 'fetch-session':
    case 'fetch-fail-excerpt':
      void refreshSession(follow.sessionId).catch(toastError)
      return
    case 'download-and-refresh':
      triggerDownload(follow.outUrl)
      void refreshSession(follow.sessionId).catch(toastError)
      return
  }
}

function onSse(ev: SseEvent): void {
  const now = performance.now()
  let follow: FollowUp = { kind: 'none' }
  switch (ev.kind) {
    case 'state-live':
    case 'state-terminal':
      follow = applyStateEvent(state, ev, Date.now())
      break
    case 'progress':
      applyProgressEvent(state, ev)
      break
    case 'frame':
      applyFrameEvent(state, ev)
      break
    case 'queue':
      applyQueueEvent(state, ev, now)
      break
    case 'encode':
      follow = applyEncodeEvent(state, ev, now)
      break
  }
  wake.invalidate()
  loop.scheduleRender()
  runFollowUp(follow)
}

// Bounded SSE replay: the snapshot is truth, SSE is deltas — resync after every retry.
async function resync(): Promise<void> {
  const [tiles, queue] = await Promise.all([net.getSessions(), net.getQueue()])
  reconcileSessions(state, tiles)
  const pending = state.pending
  if (pending != null && pending.kind === 'starting' && findTile(state.tiles, pending.id) != null) {
    state.pending = null // its session materialized while we were away
  }
  applyQueueEvent(state, { kind: 'queue', items: queue }, performance.now())
  // Encode jobs have NO REST endpoint to reconcile against, and the gap may have
  // swallowed this job's terminal 'encode' event — a slot nobody will ever clear wedges
  // the DOWNLOAD button (and the delete guard) forever. Tradeoff, accepted: dropping the
  // slot loses the progress ring for an encode that IS still running (its later events
  // are ignored, its auto-download won't fire); the button recovers and a re-click
  // re-encodes or picks up the finished artifact.
  state.download = null
  wake.invalidate()
  loop.scheduleRender()
}

let sseStarted = false
function startSse(): void {
  if (sseStarted) return
  sseStarted = true
  net.openEvents({
    onEvent: onSse,
    onOpen: () => {
      if (state.sse.phase === 'retrying') void resync().catch(toastError)
      state.sse.phase = 'open'
      loop.scheduleRender()
    },
    onError: () => {
      state.sse.phase = 'retrying'
      loop.scheduleRender()
    },
  })
}

// --- boot (RETRY re-runs it; SSE starts once, after the first success)
async function boot(): Promise<void> {
  state.boot = { phase: 'loading' }
  loop.scheduleRender()
  try {
    const [fields, tiles, queue] = await Promise.all([net.getSchemaFields(), net.getSessions(), net.getQueue()])
    state.schemaFields = fields
    state.tiles = tiles
    applyQueueEvent(state, { kind: 'queue', items: queue }, performance.now())
    state.boot = { phase: 'ready' }
    startSse()
  } catch (err) {
    state.boot = { phase: 'failed', message: err instanceof Error ? err.message : String(err) }
    console.error(err)
  }
  wake.invalidate()
  loop.scheduleRender()
}

// --- submissions (A1 optimistic flow, shared by Enter / Cmd+Enter / RE-RUN)

// One self-contained POST: the payload rides in the request body and the server
// composes it over the tuned defaults — the shared draft is never read or written
// (isolation invariant, spec §5.6). Coercion failures arrive as the 400 'rejected'
// result, same surface as preflight rejections.
function beginSubmission(prompt: string, dims: { width: number; height: number }, payload: SubmissionPayload): void {
  if (state.pending != null && state.pending.kind === 'posting') return // one in flight
  state.pending = { kind: 'posting', prompt, sizeX: dims.width, sizeY: dims.height }
  loop.renderNow() // the optimistic tile lands THIS frame, before any network
  void (async () => {
    const result = await net.postStart(payload)
    switch (result.kind) {
      case 'started':
        state.lastSeed = result.seed
        state.lastRun = { values: payload.values, forkOf: payload.forkOf, seedLocked: payload.seedLocked }
        // If SSE 'state: launching' raced ahead of this response the tile already
        // exists and pending must not linger next to it.
        state.pending =
          findTile(state.tiles, result.sessionId) != null
            ? null
            : {
                kind: 'starting',
                id: result.sessionId,
                prompt,
                sizeX: dims.width,
                sizeY: dims.height,
                deadline: performance.now() + feel.startingGraceMs,
              }
        break
      case 'queued':
        state.lastRun = { values: payload.values, forkOf: payload.forkOf, seedLocked: payload.seedLocked }
        // The optimistic tile hands over to the queued tile: queued tiles derive from
        // state.queue, so append the 202's item unless the SSE echo already landed it.
        state.pending = null
        if (findQueueItem(state.queue, result.queuedId) == null) {
          state.queue.push({
            id: result.queuedId,
            position: result.position,
            prompt,
            sizeX: dims.width,
            sizeY: dims.height,
          })
        }
        break
      case 'rejected':
        // A failed POST never touched the queue (append semantics) — queued tiles stay;
        // only the optimistic tile clears.
        state.pending = null
        showToast(state, result.message, performance.now())
        break
    }
  })()
    .catch((err: unknown) => {
      state.pending = null // network refusal: the POST never landed; the queue is untouched
      toastError(err)
    })
    .finally(() => {
      wake.invalidate()
      loop.scheduleRender()
    })
}

function submit(): void {
  if (state.boot.phase !== 'ready') return
  if (state.composer.prompt.trim() === '') return
  const composer = state.composer
  if (composer.init != null && composer.init.image.kind === 'uploading') {
    // A1 guard addition (§15.4): no optimistic tile, stop.
    toastNow('image still uploading')
    return
  }
  if (composer.aspect === 'auto' && initNaturalDims(composer.init) == null) {
    // A1 guard addition (§5.1a): AUTO selected but the attachment's dims aren't known
    // yet (rematerialized load in flight, or an unreadable image) — same surface as
    // the uploading guard; composeSubmission would rightly throw past this point.
    toastNow('image size unknown — pick an aspect')
    return
  }
  const submitInput = {
    prompt: composer.prompt,
    aspect: composer.aspect,
    size: composer.size,
    steps: composer.steps,
    look: composer.look,
    seedMode: composer.seedMode,
    tweak: composer.tweak,
    init: toInitSubmitInput(composer.init),
  }
  const payload = composeSubmission(submitInput)
  const dims = composerDims(submitInput)
  beginSubmission(composer.prompt.trim(), dims, payload)
  // The bar keeps its text; tweak mode AND the attachment persist (iterating on the base).
}

function rerunLast(): void {
  const lastRun = state.lastRun
  if (lastRun == null) {
    toastNow('nothing to re-run')
    return
  }
  const scenes = lastRun.values['scenes']
  if (typeof scenes !== 'string') throw new Error('lastRun without scenes — composeSubmission always sets it')
  const width = lastRun.values['width']
  const height = lastRun.values['height']
  const dims =
    typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0
      ? { width, height }
      : { width: 512, height: 512 }
  beginSubmission(scenes, dims, lastRun)
}

// A3 — RE-RUN: same settings, fresh seed (seedLocked: false -> the server rolls).
async function rerunSession(id: string): Promise<void> {
  const tile = findTile(state.tiles, id)
  if (tile == null) throw new Error(`re-run of unknown session ${id}`)
  const config = await ensureDetail(tile)
  const values = submittableValues(config, state.schemaFields)
  const scenes = values['scenes']
  const width = values['width']
  const height = values['height']
  beginSubmission(
    typeof scenes === 'string' ? scenes : tile.slug,
    typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0
      ? { width, height }
      : { width: 512, height: 512 },
    { values, forkOf: id, seedLocked: false },
  )
}

// A4 — TWEAK: prefill the bar + popover from the source session, lock its seed,
// rematerialize the init attachment (§15.8).
async function tweakSession(id: string): Promise<void> {
  const tile = findTile(state.tiles, id)
  if (tile == null) throw new Error(`tweak of unknown session ${id}`)
  const config = await ensureDetail(tile)
  const composer = state.composer
  const scenes = config['scenes']
  composer.prompt = typeof scenes === 'string' ? scenes : ''
  composer.tweak = { of: id, baseValues: submittableValues(config, state.schemaFields) }
  const match = matchPresets(config)
  composer.aspect = match.aspect
  composer.size = match.size
  composer.steps = match.steps
  composer.look = match.look
  const seed = config['seed']
  composer.seedMode = typeof seed === 'number' ? { kind: 'locked', seed } : { kind: 'random' }
  setInit(deriveInitFromBase(composer.tweak.baseValues))
  // A4 dims capture (§15.8): a rematerialized attachment carries no pixel dims (the
  // snapshot has none) — load them async via the uploads route. AUTO stays disabled
  // until they land; a 404 (bench-external base image) just leaves them null.
  const att = composer.init
  if (att != null && att.image.kind === 'ready' && att.image.natural == null) {
    const image = att.image
    void loadImageDims(uploadUrl(image.path)).then((natural) => {
      if (natural == null || state.composer.init !== att) return // 404/undecodable, or replaced
      image.natural = natural
      loop.scheduleRender()
    })
  }
  composer.popoverOpen = false
  closeLightbox()
  loop.renderNow()
  promptEl.focus()
  promptEl.setSelectionRange(composer.prompt.length, composer.prompt.length)
}

// --- init attachment (§15.4): three attach routes, one result

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp']

// Replace the attachment, revoking the object URL the dom layer created for the old one
// (rematerialized attachments have localUrl null — nothing to revoke). The state move is
// core's replaceInit, which also reverts a now-referentless AUTO aspect to '1:1' (§5.1a).
function setInit(init: InitAttachment | null): void {
  const prev = state.composer.init
  if (prev != null && prev.image.localUrl != null) URL.revokeObjectURL(prev.image.localUrl)
  replaceInit(state, init)
}

// The attachment's own pixel dims, decoded client-side (§15.4) — the AUTO aspect's
// input. Resolves null on a failed decode/404: expected display-boundary degradation
// (same class as thumb onerror), AUTO just stays disabled — never rejects.
function loadImageDims(url: string): Promise<NaturalDims | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function attachImage(file: File): void {
  if (state.boot.phase !== 'ready') return
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return // input-type boundary: silent
  const localUrl = URL.createObjectURL(file)
  // A new image invalidates a mask painted on the old one: the whole attachment resets.
  const att: InitAttachment = {
    image: { kind: 'uploading', name: file.name, localUrl },
    strength: 'medium',
    holdMeaning: false,
    mask: null,
  }
  setInit(att)
  loop.renderNow() // the chip renders THIS frame, before any network
  // Natural dims ride the upload wait (§15.4): both must land before 'ready', so a
  // ready fresh attachment always knows its dims (or knows they are unreadable).
  void Promise.all([net.uploadFile(file, file.name), loadImageDims(localUrl)])
    .then(([result, natural]) => {
      if (state.composer.init !== att) return // replaced or removed while uploading
      if (result.ok) {
        att.image = { kind: 'ready', name: file.name, path: result.path, localUrl, natural }
      } else {
        setInit(null) // ruling 6: toast, chip cleared, object URL revoked
        showToast(state, result.message, performance.now())
        wake.invalidate()
      }
      loop.scheduleRender()
    })
    .catch((err: unknown) => {
      console.error(err)
      if (state.composer.init === att) setInit(null)
      toastNow('upload failed')
    })
}

// First accepted image file among a DataTransfer/clipboard item list, or null.
function firstImageFile(items: DataTransferItemList): File | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind === 'file' && ACCEPTED_IMAGE_TYPES.includes(item.type)) {
      const file = item.getAsFile()
      if (file != null) return file
    }
  }
  return null
}

function dragHasImage(items: DataTransferItemList): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind === 'file' && ACCEPTED_IMAGE_TYPES.includes(item.type)) return true
  }
  return false
}

// --- mask editor (§15.7)

// The state move is the core transition (model.openMaskEditor) so its guards — the chip's
// disabled affordances AND the re-entry no-op — are model-tested; this wrapper owns the
// dom side: the paint surface and focus containment.
function openMask(): void {
  if (!openMaskEditor(state)) return // no attachment / uploading / already open (§15.7)
  const init = state.composer.init
  if (init == null) throw new Error('openMaskEditor opened without an attachment')
  openMaskSurface(init)
  // Containment (§15.7): the control that opened the editor (the MASK chip, on a keyboard
  // activation) still holds DOM focus — blur it now; the shell goes inert in the next
  // frame's projection.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  loop.scheduleRender()
}

// Esc and scrim-click share this rule: dirty -> discard confirm above the editor;
// clean -> close immediately; saving -> inert (SAVE is disabled too, the upload is brief).
function requestMaskClose(): void {
  const editor = state.maskEditor
  if (editor == null || editor.saving) return
  if (editor.dirty) state.confirm = { kind: 'discard-mask' }
  else state.maskEditor = null
  loop.scheduleRender()
}

// A6 — DOWNLOAD: existing mp4 downloads directly; otherwise one encode at a time.
async function downloadSession(id: string): Promise<void> {
  const tile = findTile(state.tiles, id)
  if (tile == null) throw new Error(`download of unknown session ${id}`)
  let newestMp4: string | null = null
  for (const artifact of tile.artifacts) {
    if (artifact.format === 'mp4') newestMp4 = artifact.name
  }
  if (newestMp4 != null) {
    triggerDownload(artifactUrl(id, newestMp4))
    return
  }
  if (state.download != null) {
    toastNow('an encode is already running')
    return
  }
  const result = await net.postEncode(id)
  if (result.ok) {
    state.download = { jobId: result.jobId, sessionId: id, framesDone: 0, framesTotal: 0 }
    loop.scheduleRender()
  } else {
    toastNow(result.message)
  }
}

// A7 — DELETE, confirm required; guards mirror the disabled affordance.
function requestDelete(id: string): void {
  const tile = findTile(state.tiles, id)
  if (tile == null) return
  if (tile.state === 'rendering') return
  if (state.download != null && state.download.sessionId === id) return
  state.confirm = { kind: 'delete', sessionId: id }
  loop.scheduleRender()
}

async function confirmDelete(): Promise<void> {
  const confirm = state.confirm
  if (confirm == null || confirm.kind !== 'delete') return
  state.confirm = null
  await net.deleteSession(confirm.sessionId)
  removeTile(state, confirm.sessionId)
  loop.scheduleRender()
}

// A8 — cancel one queued item (its tile's ×): optimistic local removal FIRST, so the SSE
// echo (published by the server during the DELETE) can never see the cancelled item as a
// drained head and phantom a 'starting' tile for it. An id already gone (double-click
// within one rAF, echo races) sends NO DELETE — the user's cancel already worked and a
// 404 would toast the misleading 'already started'. A real 404 means the item
// auto-started or was cancelled elsewhere — re-fetch the truth and say so.
function cancelQueuedItem(id: string): void {
  if (!removeQueueItem(state, id)) return
  loop.scheduleRender()
  void (async () => {
    const result = await net.deleteQueueItem(id)
    if (!result.ok) {
      state.queue = await net.getQueue()
      toastNow('no longer queued — it already started or was cancelled')
      loop.scheduleRender()
    }
  })().catch(toastError)
}

// --- lightbox open/close (A9)

function openLightbox(id: string): void {
  const tile = findTile(state.tiles, id)
  if (tile == null || tile.frames < 1) return
  const rect = tileScreenRect(id, state.scrollTop)
  if (rect == null) return // never emitted — nothing to morph from
  state.composer.popoverOpen = false // popover and lightbox are mutually exclusive
  state.lightbox = {
    sessionId: id,
    frame: tile.state === 'rendering' ? 'follow' : tile.frames,
    swipe: { direction: 'still', accumulated: 0 },
    anchor: rect,
  }
  lightboxOpenMorph(rect)
  void ensureDetail(tile).catch(toastError) // params line gains the model name
  loop.scheduleRender()
}

function closeLightbox(): void {
  const lb = state.lightbox
  if (lb == null) return
  lightboxCloseMorph(tileScreenRect(lb.sessionId, state.scrollTop)) // current rect, or fade
  state.lightbox = null
  loop.scheduleRender()
}

function togglePopover(): void {
  const opening = !state.composer.popoverOpen
  if (opening) closeLightbox() // mutually exclusive by construction
  state.composer.popoverOpen = opening
  loop.scheduleRender()
}

function dismissTopmost(): void {
  switch (topmostDismissable(state)) {
    case 'confirm':
      state.confirm = null // discard-mask CANCEL path too: editor + painting intact
      break
    case 'mask-editor':
      requestMaskClose()
      break
    case 'popover':
      state.composer.popoverOpen = false
      break
    case 'lightbox':
      closeLightbox()
      break
    case null:
      if (document.activeElement === promptEl) promptEl.blur()
      break
  }
  loop.scheduleRender()
}

// The locked-seed pin priority: tweak base seed, else the last POST's seed, else a
// fresh uint32 — the one Math.random in the app, rolled here in the dom layer.
function pinnedSeed(): number {
  const tweak = state.composer.tweak
  if (tweak != null) {
    const base = tweak.baseValues['seed']
    if (typeof base === 'number') return base
  }
  if (state.lastSeed != null) return state.lastSeed
  return Math.floor(Math.random() * 0x100000000)
}

// --- module init + event listener registration

initBar({
  scheduleRender: () => loop.scheduleRender(),
  prompt: promptEl,
  go: goEl,
  attach: attachEl,
  popover: popoverEl,
  sse: sseEl,
  chip: mustGet('chip'),
  chipThumb: mustGet('chip-thumb') as HTMLImageElement,
  chipName: mustGet('chip-name'),
  chipMask: chipMaskEl,
})
initMask(
  { state, scheduleRender: () => loop.scheduleRender(), toast: toastNow, requestClose: requestMaskClose },
  {
    root: mustGet('mask-editor'),
    scrim: mustGet('mask-scrim'),
    stage: mustGet('mask-stage'),
    img: mustGet('mask-img') as HTMLImageElement,
    overlay: mustGet('mask-overlay') as HTMLCanvasElement,
    paintBtn: mustGet('mask-paint') as HTMLButtonElement,
    eraseBtn: mustGet('mask-erase') as HTMLButtonElement,
    invertBtn: mustGet('mask-invert') as HTMLButtonElement,
    clearBtn: mustGet('mask-clear') as HTMLButtonElement,
    brush: mustGet('mask-brush') as HTMLInputElement,
    removeBtn: mustGet('mask-remove') as HTMLButtonElement,
    saveBtn: mustGet('mask-save') as HTMLButtonElement,
  },
)
initGallery({ scheduleRender: () => loop.scheduleRender(), scroller: scrollerEl, canvas: canvasEl, empty: emptyEl })
initLightbox({
  scheduleRender: () => loop.scheduleRender(),
  root: lightboxEl,
  scrim: mustGet('lb-scrim'),
  stage: mustGet('lb-stage'),
  imgA: mustGet('lb-img-a') as HTMLImageElement,
  imgB: mustGet('lb-img-b') as HTMLImageElement,
  strip: mustGet('lb-strip'),
  prompt: mustGet('lb-prompt'),
  params: mustGet('lb-params'),
  download: mustGet('lb-download') as HTMLButtonElement,
  del: mustGet('lb-delete') as HTMLButtonElement,
})
initTop({
  lightbox: lightboxEl,
  popover: popoverEl,
  mask: mustGet('mask-editor'),
  confirm: confirmEl,
  confirmText: mustGet('confirm-text'),
  confirmNote: mustGet('confirm-note'),
  toast: toastEl,
})

promptEl.addEventListener('input', () => {
  const cleared = state.composer.prompt !== '' && promptEl.value === ''
  state.composer.prompt = promptEl.value
  if (cleared) {
    // Clearing the bar resets the WHOLE composer (§15.4): tweak AND attachment — so
    // strength: null stays unreachable outside tweak, mirroring the aspect invariant.
    setInit(null)
    if (state.composer.tweak != null) {
      state.composer.tweak = null
      state.composer.aspect = '1:1'
      state.composer.size = 'full'
      state.composer.steps = 200
      state.composer.look = 'limited'
      state.composer.seedMode = { kind: 'random' }
    }
  }
  loop.renderNow() // synchronous keystroke echo — the controlled-input answer
})

goEl.addEventListener('click', submit)
gearEl.addEventListener('click', togglePopover)

// --- attach routes (§15.4): ⊕ picker, drag-drop on the bar, paste while bar focused
attachEl.addEventListener('click', () => fileInputEl.click())
fileInputEl.addEventListener('change', () => {
  const file = fileInputEl.files == null ? null : fileInputEl.files[0]
  if (file != null) attachImage(file)
  fileInputEl.value = '' // re-attaching the same file must fire change again
})
barEl.addEventListener('dragover', (e) => {
  if (e.dataTransfer == null || !dragHasImage(e.dataTransfer.items)) return
  e.preventDefault()
  barEl.classList.add('drop')
})
barEl.addEventListener('dragleave', () => barEl.classList.remove('drop'))
barEl.addEventListener('drop', (e) => {
  barEl.classList.remove('drop')
  if (e.dataTransfer == null) return
  const file = firstImageFile(e.dataTransfer.items)
  if (file == null) return // non-image drop: browser default, no chip, no request
  e.preventDefault()
  attachImage(file)
})
promptEl.addEventListener('paste', (e) => {
  if (e.clipboardData == null) return
  const file = firstImageFile(e.clipboardData.items)
  if (file == null) return // text paste keeps working as text — input-type boundary
  e.preventDefault()
  attachImage(file)
})
chipMaskEl.addEventListener('click', openMask)
mustGet('chip-x').addEventListener('click', () => {
  // Clears chip, mask, and INIT row in one gesture (ruling 6).
  setInit(null)
  loop.scheduleRender()
})

popoverEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const chip = target.closest<HTMLElement>('.chip')
  if (chip == null) return
  const aspect = chip.dataset['aspect']
  const size = chip.dataset['size']
  const steps = chip.dataset['steps']
  const look = chip.dataset['look']
  const seed = chip.dataset['seed']
  const initStrength = chip.dataset['initStrength']
  const init = state.composer.init
  if (aspect != null && aspect !== 'custom') state.composer.aspect = aspect as CreateState['composer']['aspect']
  else if (size != null && size !== 'custom') state.composer.size = size as CreateState['composer']['size']
  else if (steps != null && steps !== 'custom') state.composer.steps = parseStepsId(steps)
  else if (look != null && look !== 'custom') state.composer.look = look as CreateState['composer']['look']
  else if (seed === 'random') state.composer.seedMode = { kind: 'random' }
  else if (seed === 'locked') state.composer.seedMode = { kind: 'locked', seed: pinnedSeed() }
  else if (initStrength != null && initStrength !== 'custom' && init != null) init.strength = initStrength as InitStrengthId
  else if (chip.dataset['hold'] != null && init != null) init.holdMeaning = !init.holdMeaning
  loop.scheduleRender()
})

// Popover outside-click closes it (A11).
document.addEventListener('pointerdown', (e) => {
  if (!state.composer.popoverOpen) return
  const target = e.target as HTMLElement
  if (popoverEl.contains(target) || gearEl.contains(target)) return
  state.composer.popoverOpen = false
  loop.scheduleRender()
})

scrollerEl.addEventListener('scroll', () => {
  state.scrollTop = scrollerEl.scrollTop
  loop.scheduleRender()
})

scrollerEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const tile = target.closest<HTMLElement>('.tile')
  const key = tile?.dataset['key']
  if (target.closest('.tile-x') != null) {
    // × only renders on queued entries, whose key is the queue item id.
    if (key != null && key !== 'pending') cancelQueuedItem(key)
    return
  }
  if (key == null || key === 'pending') return
  openLightbox(key)
})

lightboxEl.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (state.lightbox == null) return
  wheelDelta += e.deltaY
  loop.scheduleRender()
}, { passive: false })

mustGet('lb-scrim').addEventListener('click', closeLightbox)

mustGet('lb-strip').addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('.lb-thumb')
  const lb = state.lightbox
  if (target == null || lb == null) return
  const frame = Number(target.dataset['frame'])
  const tile = findTile(state.tiles, lb.sessionId)
  if (tile == null || !Number.isInteger(frame)) throw new Error(`strip click on bad frame "${target.dataset['frame']}"`)
  state.lightbox = jumpToFrame(lb, tile, frame)
  loop.scheduleRender()
})

mustGet('lb-rerun').addEventListener('click', () => {
  const lb = state.lightbox
  if (lb != null) void rerunSession(lb.sessionId).catch(toastError) // lightbox stays open
})
mustGet('lb-tweak').addEventListener('click', () => {
  const lb = state.lightbox
  if (lb != null) void tweakSession(lb.sessionId).catch(toastError)
})
mustGet('lb-advanced').addEventListener('click', () => {
  const lb = state.lightbox
  if (lb != null) window.open(`/bench.html#s=${lb.sessionId}`) // A5, new tab
})
mustGet('lb-download').addEventListener('click', () => {
  const lb = state.lightbox
  if (lb != null) void downloadSession(lb.sessionId).catch(toastError)
})
mustGet('lb-delete').addEventListener('click', () => {
  const lb = state.lightbox
  if (lb != null) requestDelete(lb.sessionId)
})
mustGet('lb-prompt').addEventListener('click', () => {
  mustGet('lb-prompt').classList.toggle('expanded')
})

mustGet('confirm-yes').addEventListener('click', () => {
  const confirm = state.confirm
  if (confirm == null) return
  switch (confirm.kind) {
    case 'delete':
      void confirmDelete().catch(toastError)
      return
    case 'discard-mask':
      // Discard: editor closes; the chip's previous mask state is untouched (§15.7).
      state.confirm = null
      state.maskEditor = null
      loop.scheduleRender()
      return
  }
})
mustGet('confirm-no').addEventListener('click', () => {
  state.confirm = null
  loop.scheduleRender()
})

mustGet('boot-retry').addEventListener('click', () => void boot())

window.addEventListener('keydown', (e) => {
  const active = document.activeElement
  const inInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
  const intent = keyIntent({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, inInput })
  // §15.7 scope rule: while the mask editor is open, only `dismiss` acts — submit,
  // rerun-last, focus-prompt and frame-prev/next are inert (the intent map is unchanged).
  if (state.maskEditor != null && intent !== 'dismiss') return
  switch (intent) {
    case 'submit':
      e.preventDefault()
      submit()
      return
    case 'rerun-last':
      e.preventDefault()
      rerunLast()
      return
    case 'dismiss':
      dismissTopmost()
      return
    case 'focus-prompt':
      e.preventDefault()
      promptEl.focus()
      return
    case 'frame-prev':
    case 'frame-next': {
      const lb = state.lightbox
      if (lb == null) return // lightbox-scoped
      e.preventDefault()
      const tile = findTile(state.tiles, lb.sessionId)
      if (tile == null) throw new Error(`lightbox on unknown session ${lb.sessionId}`)
      state.lightbox = stepFrame(lb, tile, intent === 'frame-next' ? 1 : -1)
      loop.scheduleRender()
      return
    }
    case 'none':
      return
  }
})

// --- env: read once, then only through the watcher
watchEnv((env) => {
  state.env = env
  loop.scheduleRender()
})
state.env = readEnv()

void boot()
