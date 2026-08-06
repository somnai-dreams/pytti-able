// renderLightbox.ts — stage double-buffer (two <img>, swap on load — never blanks), the
// two reels (jobs: vertical right strip, one thumb per session = its latest frame;
// frames: smaller horizontal bottom strip) via kit/reel-strip scan + anchor morph, spring
// FLIP open/close from the copied masonry rect, and the chrome band (prompt, params,
// actions). All geometry from data (env + tile dims + feel) — no DOM measurement.
import { center, fit } from '@kit/midui/num'
import { spring, springGoToEnd, springMostlyDone, springStep, type Spring } from '@kit/midui/motion'
import { anchorMorph, anchorTravelY, reelAnchorScan } from '@kit/reel-strip/core'
import { frameUrl, thumbUrl } from '../core/api'
import { feel } from '../core/feel'
import { jobRef, makeFramesSource, makeJobsSource, resolvedFrame } from '../core/lightbox'
import { findTile, type CreateState, type Tile } from '../core/model'
import type { TileRect } from './renderGallery'

let root: HTMLElement
let scrim: HTMLElement
let stage: HTMLElement
let imgs: [HTMLImageElement, HTMLImageElement]
let jobsStripEl: HTMLElement
let framesStripEl: HTMLElement
let promptEl: HTMLElement
let paramsEl: HTMLElement
let downloadBtn: HTMLButtonElement
let deleteBtn: HTMLButtonElement

// Morph springs: geometry (x, y, sizeX, sizeY) + one lifecycle spring t (scrim/chrome
// opacity; t reaching 0 after close hides the root).
const t = spring(0)
const rx = spring(0)
const ry = spring(0)
const rw = spring(1)
const rh = spring(1)
let closeTarget: TileRect | null = null

// Stage double-buffer bookkeeping (dom cache beside the store, never in it).
let frontIndex = 0
let shownSrc = ''
let loadingSrc = ''
let preloadedSrc = ''
const preloader = new Image()

// Frames reel pool: keyed by 1-based frame index, valid for ONE session at a time
// (framesPoolSession) — a job switch invalidates it wholesale.
const framesPool = new Map<number, HTMLImageElement>()
const framesMarked = new Set<number>()
let framesPoolSession = ''

// Jobs reel pool: keyed by session id. A node's src is re-derived every walk — a
// rendering job's latest thumb index moves as frames land.
const jobsPool = new Map<string, HTMLImageElement>()
const jobsMarked = new Set<string>()

let scheduleRender: () => void = () => {
  throw new Error('renderLightbox used before initLightbox')
}

export function initLightbox(deps: {
  scheduleRender: () => void
  root: HTMLElement
  scrim: HTMLElement
  stage: HTMLElement
  imgA: HTMLImageElement
  imgB: HTMLImageElement
  jobs: HTMLElement
  frames: HTMLElement
  prompt: HTMLElement
  params: HTMLElement
  download: HTMLButtonElement
  del: HTMLButtonElement
}): void {
  scheduleRender = deps.scheduleRender
  root = deps.root
  scrim = deps.scrim
  stage = deps.stage
  imgs = [deps.imgA, deps.imgB]
  jobsStripEl = deps.jobs
  framesStripEl = deps.frames
  promptEl = deps.prompt
  paramsEl = deps.params
  downloadBtn = deps.download
  deleteBtn = deps.del
  for (let i = 0; i < 2; i++) {
    imgs[i]!.addEventListener('load', () => {
      // Only the back buffer's load swaps; a stale front load is a no-op.
      if (i !== frontIndex && imgs[i]!.getAttribute('src') === loadingSrc && loadingSrc !== '') {
        frontIndex = i
        shownSrc = loadingSrc
        loadingSrc = ''
        scheduleRender()
      }
    })
    imgs[i]!.addEventListener('error', () => {
      // A failed frame load must not wedge the double-buffer (loadingSrc would block
      // every future want of that URL): clear it so the next rendered frame that still
      // wants the URL re-requests it. Deliberately no scheduleRender — a perpetual 404
      // must not drive a rAF-rate retry loop; the retry rides the next real render.
      if (i !== frontIndex && imgs[i]!.getAttribute('src') === loadingSrc && loadingSrc !== '') {
        loadingSrc = ''
      }
    })
  }
}

// Seed the FLIP springs at the tile's screen rect (copied masonry cursor data).
export function lightboxOpenMorph(from: { x: number; y: number; sizeX: number; sizeY: number }): void {
  rx.pos = from.x
  ry.pos = from.y
  rw.pos = from.sizeX
  rh.pos = from.sizeY
  rx.v = ry.v = rw.v = rh.v = 0
  t.pos = 0
  t.v = 0
  closeTarget = null
  // Reset the stage buffers — the previous session's pixels must not flash.
  shownSrc = ''
  loadingSrc = ''
  preloadedSrc = ''
  imgs[0]!.removeAttribute('src')
  imgs[1]!.removeAttribute('src')
}

// Close toward the tile's CURRENT placement rect (re-copied at close time — the tile may
// have moved), or fade in place when the tile was evicted / deleted.
export function lightboxCloseMorph(to: TileRect | null): void {
  closeTarget = to
}

function setRectDest(x: number, y: number, sizeX: number, sizeY: number): void {
  rx.dest = x
  ry.dest = y
  rw.dest = sizeX
  rh.dest = sizeY
}

function stepAll(steps: number, reducedMotion: boolean): void {
  const springs: Spring[] = [t, rx, ry, rw, rh]
  for (const s of springs) {
    if (reducedMotion) springGoToEnd(s)
    else for (let i = 0; i < steps; i++) springStep(s)
  }
}

function renderStage(tile: Tile, resolved: number): void {
  const want = frameUrl(tile.id, resolved)
  if (want !== shownSrc && want !== loadingSrc) {
    loadingSrc = want
    imgs[1 - frontIndex]!.src = want
  }
  imgs[frontIndex]!.style.opacity = shownSrc !== '' ? '1' : '0'
  imgs[1 - frontIndex]!.style.opacity = '0'
  // Preload one neighbor toward likely travel (behind when pinned, since 'follow'
  // already loads the newest as it lands).
  const neighbor = resolved > 1 ? resolved - 1 : resolved + 1
  if (neighbor >= 1 && neighbor <= tile.frames) {
    const url = frameUrl(tile.id, neighbor)
    if (url !== preloadedSrc) {
      preloadedSrc = url
      preloader.src = url
    }
  }
}

// The frames reel: horizontal, bottom band, smaller thumbs — scrubs within the open job.
// A rendering job's new frames appear here as they land (positions walk tile.frames).
function renderFramesStrip(state: CreateState, tile: Tile, resolved: number): void {
  const lb = state.lightbox
  if (lb == null) throw new Error('renderFramesStrip without a lightbox')
  if (framesPoolSession !== tile.id) {
    // Frame indices now key a different session's thumbs — drop the pool wholesale.
    framesPoolSession = tile.id
    for (const node of framesPool.values()) node.remove()
    framesPool.clear()
  }
  const scan = reelAnchorScan(
    makeFramesSource(tile),
    Number.POSITIVE_INFINITY, // no anchor hit wanted — walk every frame's strip x
    feel.frameItemSize,
    0, // one group — the group gap never applies on this axis
    { group: 0, item: resolved - 1 },
  )
  const positions = scan.positions
  const focusedIndex = resolved - 1
  const focusedPos = positions[focusedIndex]
  if (focusedPos == null) throw new Error(`frames scan missing frame ${resolved}/${tile.frames}`)

  const acc = lb.swipeX.accumulated
  const morph = anchorMorph(acc, feel.swipeThreshold, feel.frameAnchorSize, feel.frameItemSize)
  const incomingIndex = acc > 0 ? focusedIndex + 1 : acc < 0 ? focusedIndex - 1 : -1
  const bandX = state.env.viewportX - feel.stripBandX // strip band width (right of it: jobs reel)
  const restLeft = bandX / 2 - feel.frameAnchorSize / 2
  // anchorTravelY is 1-D scan-axis math — here the scan axis is horizontal.
  const focusedLeft = anchorTravelY(acc, feel.swipeThreshold, restLeft, feel.frameItemSize, feel.frameAnchorSize, 0, false)
  const grow = feel.frameAnchorSize - feel.frameItemSize
  const bandMiddleY = feel.frameBandY / 2

  framesMarked.clear()
  for (let i = 0; i < positions.length; i++) {
    const frame = i + 1
    let left: number
    let size: number
    if (i === focusedIndex) {
      left = focusedLeft
      size = morph.current
    } else {
      left = restLeft + (positions[i]!.y - focusedPos.y) + (i > focusedIndex ? grow : 0)
      size = i === incomingIndex ? morph.incoming : feel.frameItemSize
    }
    if (left + size < -feel.frameAnchorSize * 2 || left > bandX + feel.frameAnchorSize * 2) continue

    let node = framesPool.get(frame)
    if (node == null) {
      const created = document.createElement('img')
      created.className = 'lb-thumb'
      created.draggable = false
      created.alt = ''
      created.dataset['frame'] = String(frame)
      created.src = thumbUrl(tile.id, frame)
      created.addEventListener('load', scheduleRender)
      created.addEventListener('error', () => {
        // A failed thumb must not sit blank in the strip forever: evict it so the next
        // render walk recreates it (a fresh request). Identity-checked — a late error
        // must not evict a successor node for this frame index (pool rebuilt after a
        // close/open or job switch). No scheduleRender — no tight retry loop.
        if (framesPool.get(frame) === created) {
          created.remove()
          framesPool.delete(frame)
        }
      })
      framesStripEl.appendChild(created)
      framesPool.set(frame, created)
      node = created
    }
    framesMarked.add(frame)
    node.style.transform = `translate(${left}px, ${bandMiddleY - size / 2}px)`
    node.style.width = `${size}px`
    node.style.height = `${size}px`
    node.classList.toggle('focused', i === focusedIndex)
  }
  for (const [frame, node] of framesPool) {
    if (!framesMarked.has(frame)) {
      node.remove()
      framesPool.delete(frame)
    }
  }
}

// The jobs reel: vertical, right edge — one thumb per session (its latest frame), in
// gallery order; frameless sessions are hidden by the source and never walked.
function renderJobsStrip(state: CreateState, tile: Tile): void {
  const lb = state.lightbox
  if (lb == null) throw new Error('renderJobsStrip without a lightbox')
  const tiles = state.tiles
  const anchorRef = jobRef(tiles, tile.id)
  const scan = reelAnchorScan(makeJobsSource(tiles), Number.POSITIVE_INFINITY, feel.itemSize, feel.groupGapY, anchorRef)
  const positions = scan.positions
  // positions hold only visible jobs — locate the open job's walk index.
  let focusedIndex = -1
  for (let i = 0; i < positions.length; i++) {
    if (positions[i]!.ref.group === anchorRef.group) {
      focusedIndex = i
      break
    }
  }
  const focusedPos = positions[focusedIndex]
  if (focusedPos == null) throw new Error(`jobs scan missing session ${tile.id}`)

  const acc = lb.swipeY.accumulated
  const morph = anchorMorph(acc, feel.jobSwipeThreshold, feel.anchorSize, feel.itemSize)
  const incomingIndex = acc > 0 ? focusedIndex + 1 : acc < 0 ? focusedIndex - 1 : -1
  const viewportY = state.env.viewportY
  const restTop = viewportY / 2 - feel.anchorSize / 2
  // Every job is its own group, so a job swipe always crosses a group boundary.
  const focusedTop = anchorTravelY(acc, feel.jobSwipeThreshold, restTop, feel.itemSize, feel.anchorSize, feel.groupGapY, true)
  const grow = feel.anchorSize - feel.itemSize
  const bandCenter = feel.stripBandX / 2

  jobsMarked.clear()
  for (let i = 0; i < positions.length; i++) {
    const jobTile = tiles[positions[i]!.ref.group]!
    let top: number
    let size: number
    if (i === focusedIndex) {
      top = focusedTop
      size = morph.current
    } else {
      top = restTop + (positions[i]!.y - focusedPos.y) + (i > focusedIndex ? grow : 0)
      size = i === incomingIndex ? morph.incoming : feel.itemSize
    }
    if (top + size < -feel.anchorSize * 2 || top > viewportY + feel.anchorSize * 2) continue

    let node = jobsPool.get(jobTile.id)
    if (node == null) {
      const created = document.createElement('img')
      created.className = 'lb-thumb'
      created.draggable = false
      created.alt = ''
      created.dataset['session'] = jobTile.id
      created.addEventListener('load', scheduleRender)
      created.addEventListener('error', () => {
        // Same evict-to-retry rule as the frames reel, identity-checked, no tight loop.
        if (jobsPool.get(jobTile.id) === created) {
          created.remove()
          jobsPool.delete(jobTile.id)
        }
      })
      jobsStripEl.appendChild(created)
      jobsPool.set(jobTile.id, created)
      node = created
    }
    // Derived src, re-checked every walk: a rendering job's latest thumb index moves as
    // frames land. The old bitmap stays up while the new one decodes (gallery-tile
    // precedent — no blank flash).
    const src = thumbUrl(jobTile.id, jobTile.frames)
    if (node.getAttribute('src') !== src) node.src = src
    jobsMarked.add(jobTile.id)
    node.style.transform = `translate(${bandCenter - size / 2}px, ${top}px)`
    node.style.width = `${size}px`
    node.style.height = `${size}px`
    node.classList.toggle('focused', i === focusedIndex)
  }
  for (const [id, node] of jobsPool) {
    if (!jobsMarked.has(id)) {
      node.remove()
      jobsPool.delete(id)
    }
  }
}

function renderChrome(state: CreateState, tile: Tile, resolved: number): void {
  promptEl.textContent = tile.scenes ?? tile.slug
  const live = tile.live
  const steps =
    tile.state === 'rendering' && live != null && live.stepsTotal > 0
      ? `${live.step}/${live.stepsTotal}`
      : `${tile.stepsDone}/${tile.stepsTotal}`
  const detail = tile.detail
  const rawModel = detail == null ? null : detail['image_model']
  const model = typeof rawModel === 'string' ? rawModel : '···' // skeleton dashes until detail resolves
  const seed = tile.seed == null ? '—' : String(tile.seed)
  paramsEl.textContent = `${tile.sizeX}×${tile.sizeY} · ${steps} steps · ${model} · seed ${seed} · frame ${resolved}/${tile.frames}`

  // Never delete a rendering session (409) or one whose encode is in flight.
  const download = state.download
  if (download != null && download.sessionId === tile.id) {
    downloadBtn.textContent = `↓ ${download.framesDone}/${download.framesTotal > 0 ? download.framesTotal : '…'}`
    downloadBtn.classList.add('busy')
    deleteBtn.disabled = true
  } else {
    downloadBtn.textContent = '↓ DOWNLOAD'
    downloadBtn.classList.remove('busy')
    deleteBtn.disabled = tile.state === 'rendering'
  }
}

// Returns true while any spring is live (main also keeps scheduling while the swipe
// accumulators decay).
export function renderLightbox(state: CreateState, springSteps: number): boolean {
  const lb = state.lightbox
  const openTile = lb == null ? null : findTile(state.tiles, lb.sessionId)
  if (lb != null && openTile == null) throw new Error(`lightbox open on unknown session ${lb.sessionId}`)

  if (lb != null && openTile != null) {
    const tile = openTile
    t.dest = 1
    // Fitted stage rect from data: viewport minus the jobs band (right), the frames
    // band + chrome band (bottom).
    const areaX = state.env.viewportX - feel.stripBandX - 2 * feel.stageMargin
    const areaY = state.env.viewportY - feel.chromeBandY - feel.frameBandY - 2 * feel.stageMargin
    const ar = tile.sizeX / tile.sizeY
    const w = fit(ar, areaX, areaY)
    const h = w / ar
    setRectDest(feel.stageMargin + center(w, areaX), feel.stageMargin + center(h, areaY), w, h)
  } else {
    t.dest = 0
    if (closeTarget != null) setRectDest(closeTarget.x, closeTarget.y, closeTarget.sizeX, closeTarget.sizeY)
    // No target (tile evicted or deleted): rect springs keep their dest — centered fade.
  }

  stepAll(springSteps, state.env.reducedMotion)

  const opacity = Math.max(0, Math.min(1, t.pos))
  const active = lb != null || opacity > 0.02
  root.style.display = active ? '' : 'none'
  if (!active) {
    // Fully closed: drop both reel pools so a stale session's thumbs never flash.
    for (const node of framesPool.values()) node.remove()
    framesPool.clear()
    framesPoolSession = ''
    for (const node of jobsPool.values()) node.remove()
    jobsPool.clear()
    return false
  }

  scrim.style.opacity = String(opacity)
  stage.style.transform = `translate(${rx.pos}px, ${ry.pos}px)`
  stage.style.width = `${rw.pos}px`
  stage.style.height = `${rh.pos}px`
  root.classList.toggle('closing', lb == null)

  if (lb != null && openTile != null) {
    const resolved = resolvedFrame(lb, openTile)
    renderStage(openTile, resolved)
    renderFramesStrip(state, openTile, resolved)
    renderJobsStrip(state, openTile)
    renderChrome(state, openTile, resolved)
  }

  return !(springMostlyDone(t) && springMostlyDone(rx) && springMostlyDone(ry) && springMostlyDone(rw) && springMostlyDone(rh))
}
