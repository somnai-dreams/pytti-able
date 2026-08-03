// renderLightbox.ts — stage double-buffer (two <img>, swap on load — never blanks),
// reel strip via kit/reel-strip scan + anchor morph, spring FLIP open/close from the
// copied masonry rect, and the chrome band (prompt, params, actions). All geometry from
// data (env + tile dims + feel) — no DOM measurement.
import { center, fit } from '@kit/midui/num'
import { spring, springGoToEnd, springMostlyDone, springStep, type Spring } from '@kit/midui/motion'
import { anchorMorph, anchorTravelY, reelAnchorScan } from '@kit/reel-strip/core'
import { frameUrl, thumbUrl } from '../core/api'
import { feel } from '../core/feel'
import { makeReelSource, resolvedFrame } from '../core/lightbox'
import { findTile, type CreateState, type Tile } from '../core/model'
import type { TileRect } from './renderGallery'

let root: HTMLElement
let scrim: HTMLElement
let stage: HTMLElement
let imgs: [HTMLImageElement, HTMLImageElement]
let stripEl: HTMLElement
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

const stripPool = new Map<number, HTMLImageElement>()
const stripMarked = new Set<number>()

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
  strip: HTMLElement
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
  stripEl = deps.strip
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

function renderStrip(state: CreateState, tile: Tile, resolved: number): void {
  const lb = state.lightbox
  if (lb == null) throw new Error('renderStrip without a lightbox')
  const scan = reelAnchorScan(
    makeReelSource(tile),
    Number.POSITIVE_INFINITY, // no anchor hit wanted — walk every frame's strip y
    feel.itemSize,
    feel.groupGapY,
    { group: 0, item: resolved - 1 },
  )
  const positions = scan.positions
  const focusedIndex = resolved - 1
  const focusedPos = positions[focusedIndex]
  if (focusedPos == null) throw new Error(`strip scan missing frame ${resolved}/${tile.frames}`)

  const acc = lb.swipe.accumulated
  const morph = anchorMorph(acc, feel.swipeThreshold, feel.anchorSize, feel.itemSize)
  const incomingIndex = acc > 0 ? focusedIndex + 1 : acc < 0 ? focusedIndex - 1 : -1
  const viewportY = state.env.viewportY
  const restTop = viewportY / 2 - feel.anchorSize / 2
  const focusedTop = anchorTravelY(acc, feel.swipeThreshold, restTop, feel.itemSize, feel.anchorSize, feel.groupGapY, false)
  const grow = feel.anchorSize - feel.itemSize
  const bandCenter = feel.stripBandX / 2

  stripMarked.clear()
  for (let i = 0; i < positions.length; i++) {
    const frame = i + 1
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

    let node = stripPool.get(frame)
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
        // close/open). No scheduleRender — same no-tight-retry-loop rule as the stage.
        if (stripPool.get(frame) === created) {
          created.remove()
          stripPool.delete(frame)
        }
      })
      stripEl.appendChild(created)
      stripPool.set(frame, created)
      node = created
    }
    stripMarked.add(frame)
    node.style.transform = `translate(${bandCenter - size / 2}px, ${top}px)`
    node.style.width = `${size}px`
    node.style.height = `${size}px`
    node.classList.toggle('focused', i === focusedIndex)
  }
  for (const [frame, node] of stripPool) {
    if (!stripMarked.has(frame)) {
      node.remove()
      stripPool.delete(frame)
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
// accumulator decays).
export function renderLightbox(state: CreateState, springSteps: number): boolean {
  const lb = state.lightbox
  const openTile = lb == null ? null : findTile(state.tiles, lb.sessionId)
  if (lb != null && openTile == null) throw new Error(`lightbox open on unknown session ${lb.sessionId}`)

  if (lb != null && openTile != null) {
    const tile = openTile
    t.dest = 1
    // Fitted stage rect from data: viewport minus the strip band and chrome band.
    const areaX = state.env.viewportX - feel.stripBandX - 2 * feel.stageMargin
    const areaY = state.env.viewportY - feel.chromeBandY - 2 * feel.stageMargin
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
    // Fully closed: drop the strip pool so a stale session's thumbs never flash.
    for (const node of stripPool.values()) node.remove()
    stripPool.clear()
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
    renderStrip(state, openTile, resolved)
    renderChrome(state, openTile, resolved)
  }

  return !(springMostlyDone(t) && springMostlyDone(rx) && springMostlyDone(ry) && springMostlyDone(rw) && springMostlyDone(rh))
}
