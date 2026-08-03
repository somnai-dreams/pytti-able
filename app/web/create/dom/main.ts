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
import { artifactUrl } from '../core/api'
import { feel } from '../core/feel'
import { keyIntent } from '../core/keys'
import { applyWheel, jumpToFrame, stepFrame } from '../core/lightbox'
import {
  applyEncodeEvent,
  applyFrameEvent,
  applyProgressEvent,
  applyQueueEvent,
  applyStateEvent,
  type CreateState,
  failSubmission,
  findTile,
  type FollowUp,
  insertTile,
  reconcileSessions,
  removeTile,
  showToast,
  type SseEvent,
  type Tile,
} from '../core/model'
import { composeDraft, composerDims, draftableValues, type DraftPayload, matchPresets } from '../core/presets'
import { topmostDismissable } from '../core/surfaces'
import * as net from './net'
import { initBar, renderBar } from './renderBar'
import { initGallery, renderGallery, tileScreenRect } from './renderGallery'
import { initLightbox, lightboxCloseMorph, lightboxOpenMorph, renderLightbox } from './renderLightbox'
import { initTop, renderTop } from './renderTop'

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el == null) throw new Error(`missing #${id}`)
  return el
}

// --- static shell elements
const promptEl = mustGet('prompt') as HTMLInputElement
const gearEl = mustGet('gear') as HTMLButtonElement
const goEl = mustGet('go') as HTMLButtonElement
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

// --- the single state object
const state: CreateState = {
  boot: { phase: 'loading' },
  env: defaultEnv(),
  draftFields: [],
  tiles: [],
  pending: null,
  queue: null,
  composer: {
    prompt: '',
    aspect: '1:1',
    quality: 'standard',
    look: 'limited',
    seedMode: { kind: 'random' },
    tweak: null,
    popoverOpen: false,
  },
  lastRun: null,
  lastSeed: null,
  lightbox: null,
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

  let animating = false
  if (renderBar(state, steps)) animating = true
  if (renderGallery(state, steps)) animating = true
  if (renderLightbox(state, steps)) animating = true
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
  if (pending != null && pending.kind !== 'posting' && findTile(state.tiles, pending.id) != null) {
    state.pending = null // its session materialized while we were away
  }
  applyQueueEvent(state, { kind: 'queue', queued: queue }, performance.now())
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
    state.draftFields = fields
    state.tiles = tiles
    applyQueueEvent(state, { kind: 'queue', queued: queue }, performance.now())
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

function beginSubmission(prompt: string, dims: { width: number; height: number }, payload: DraftPayload): void {
  if (state.pending != null && state.pending.kind === 'posting') return // one in flight
  state.pending = { kind: 'posting', prompt, sizeX: dims.width, sizeY: dims.height }
  loop.renderNow() // the optimistic tile lands THIS frame, before any network
  void (async () => {
    const put = await net.putDraft(payload)
    if (!put.ok) {
      failSubmission(state) // the queue mirror's tile survives a failed replacement
      showToast(state, put.message, performance.now())
      return
    }
    const result = await net.postStart()
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
        state.pending = { kind: 'queued', id: result.queuedId, prompt, sizeX: dims.width, sizeY: dims.height }
        if (result.replaced) showToast(state, 'replaced queued render', performance.now())
        break
      case 'rejected':
        failSubmission(state)
        showToast(state, result.message, performance.now())
        break
    }
  })()
    .catch((err: unknown) => {
      failSubmission(state)
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
  const payload = composeDraft(state.composer)
  const dims = composerDims(state.composer)
  beginSubmission(state.composer.prompt.trim(), dims, payload)
  // The bar keeps its text; tweak mode persists (iterating on the same base).
}

function rerunLast(): void {
  const lastRun = state.lastRun
  if (lastRun == null) {
    toastNow('nothing to re-run')
    return
  }
  const scenes = lastRun.values['scenes']
  if (typeof scenes !== 'string') throw new Error('lastRun without scenes — composeDraft always sets it')
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
  const values = draftableValues(config, state.draftFields)
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

// A4 — TWEAK: prefill the bar + popover from the source session, lock its seed.
async function tweakSession(id: string): Promise<void> {
  const tile = findTile(state.tiles, id)
  if (tile == null) throw new Error(`tweak of unknown session ${id}`)
  const config = await ensureDetail(tile)
  const composer = state.composer
  const scenes = config['scenes']
  composer.prompt = typeof scenes === 'string' ? scenes : ''
  composer.tweak = { of: id, baseValues: draftableValues(config, state.draftFields) }
  const match = matchPresets(config)
  composer.aspect = match.aspect
  composer.quality = match.quality
  composer.look = match.look
  const seed = config['seed']
  composer.seedMode = typeof seed === 'number' ? { kind: 'locked', seed } : { kind: 'random' }
  composer.popoverOpen = false
  closeLightbox()
  loop.renderNow()
  promptEl.focus()
  promptEl.setSelectionRange(composer.prompt.length, composer.prompt.length)
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
  if (confirm == null) return
  state.confirm = null
  await net.deleteSession(confirm.sessionId)
  removeTile(state, confirm.sessionId)
  loop.scheduleRender()
}

// A8 — cancel queued: server slot first, then our optimistic clear (the SSE echo no-ops).
async function cancelQueued(): Promise<void> {
  await net.deleteQueue()
  state.pending = null
  loop.scheduleRender()
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
      state.confirm = null
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

initBar({ prompt: promptEl, go: goEl, popover: popoverEl, sse: sseEl })
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
  confirm: confirmEl,
  confirmText: mustGet('confirm-text'),
  confirmNote: mustGet('confirm-note'),
  toast: toastEl,
})

promptEl.addEventListener('input', () => {
  const cleared = state.composer.prompt !== '' && promptEl.value === ''
  state.composer.prompt = promptEl.value
  if (cleared && state.composer.tweak != null) {
    // Clearing the bar leaves tweak mode: back to concrete fresh defaults.
    state.composer.tweak = null
    state.composer.aspect = '1:1'
    state.composer.quality = 'standard'
    state.composer.look = 'limited'
    state.composer.seedMode = { kind: 'random' }
  }
  loop.renderNow() // synchronous keystroke echo — the controlled-input answer
})

goEl.addEventListener('click', submit)
gearEl.addEventListener('click', togglePopover)

popoverEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const chip = target.closest<HTMLElement>('.chip')
  if (chip == null) return
  const aspect = chip.dataset['aspect']
  const quality = chip.dataset['quality']
  const look = chip.dataset['look']
  const seed = chip.dataset['seed']
  if (aspect != null && aspect !== 'custom') state.composer.aspect = aspect as CreateState['composer']['aspect']
  else if (quality != null && quality !== 'custom') state.composer.quality = quality as CreateState['composer']['quality']
  else if (look != null && look !== 'custom') state.composer.look = look as CreateState['composer']['look']
  else if (seed === 'random') state.composer.seedMode = { kind: 'random' }
  else if (seed === 'locked') state.composer.seedMode = { kind: 'locked', seed: pinnedSeed() }
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
  if (target.closest('.tile-x') != null) {
    void cancelQueued().catch(toastError)
    return
  }
  const tile = target.closest<HTMLElement>('.tile')
  const key = tile?.dataset['key']
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

mustGet('confirm-yes').addEventListener('click', () => void confirmDelete().catch(toastError))
mustGet('confirm-no').addEventListener('click', () => {
  state.confirm = null
  loop.scheduleRender()
})

mustGet('boot-retry').addEventListener('click', () => void boot())

window.addEventListener('keydown', (e) => {
  const active = document.activeElement
  const inInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
  const intent = keyIntent({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, inInput })
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
