// renderGallery.ts — the masonry walk projected onto absolutely-positioned tile nodes.
// JIT node map keyed by entry identity (session id / 'pending'), mark-and-sweep eviction
// per frame, cursor fields COPIED during emit (never the cursor itself — kit poisoning
// contract). The copied rect doubles as the lightbox open-anchor. Scroll anchoring via
// anchorScrollAdjustment keeps prepends from yanking a scrolled view.
import { masonryColumnCount, placeMasonry, uniformColumnFractions, anchorScrollAdjustment } from '@kit/masonry/core'
import { spring, type Spring, springGoToEnd, springMostlyDone, springStep } from '@kit/midui/motion'
import { thumbUrl } from '../core/api'
import { feel } from '../core/feel'
import { deriveGallery, entryKey, type GalleryEntry, makeMasonrySource } from '../core/gallery'
import type { CreateState, Tile } from '../core/model'

export type TileRect = { x: number; y: number; sizeX: number; sizeY: number }

type TileNodes = {
  root: HTMLElement
  img: HTMLImageElement
  skel: HTMLElement
  label: HTMLElement
  chip: HTMLElement
  cancel: HTMLElement
  stop: HTMLElement
  bar: HTMLElement
  barFill: HTMLElement
  foot: HTMLElement
  rect: TileRect // copied from the masonry cursor at placement (content coords)
  imgSrc: string
  imgLoaded: boolean
  imgFailed: boolean // current imgSrc errored — show the error slab, not endless shimmer
  entry: Spring // fade/rise-in on first appearance
  marked: boolean
}

let scheduleRender: () => void = () => {
  throw new Error('renderGallery used before initGallery')
}
let scroller: HTMLElement
let canvas: HTMLElement
let emptyEl: HTMLElement

const nodes = new Map<string, TileNodes>()

export function initGallery(deps: { scheduleRender: () => void; scroller: HTMLElement; canvas: HTMLElement; empty: HTMLElement }): void {
  scheduleRender = deps.scheduleRender
  scroller = deps.scroller
  canvas = deps.canvas
  emptyEl = deps.empty
}

// The lightbox open/close anchor: the entry's last placed rect in SCREEN coords,
// derived from the copied content rect + the scroller's data-model position.
export function tileScreenRect(key: string, scrollTop: number): TileRect | null {
  const node = nodes.get(key)
  if (node == null) return null
  return { x: node.rect.x, y: feel.barAreaY + node.rect.y - scrollTop, sizeX: node.rect.sizeX, sizeY: node.rect.sizeY }
}

function makeNode(key: string): TileNodes {
  const root = document.createElement('div')
  root.className = 'tile'
  root.dataset['key'] = key
  const img = document.createElement('img')
  img.className = 'tile-img'
  img.draggable = false
  img.alt = ''
  const skel = document.createElement('div')
  skel.className = 'tile-skel'
  const label = document.createElement('div')
  label.className = 'tile-label'
  const chip = document.createElement('div')
  chip.className = 'tile-chip'
  const cancel = document.createElement('button')
  cancel.className = 'tile-x'
  cancel.textContent = '×'
  cancel.title = 'cancel queued render'
  // STOP is visually distinct from the queued ×: stopping KEEPS the work (the session
  // lands 'stopped' with its frames); × discards a queued item (A13 vs A8).
  const stop = document.createElement('button')
  stop.className = 'tile-stop'
  stop.textContent = '◼ STOP'
  stop.title = 'stop — keeps the frames rendered so far'
  const bar = document.createElement('div')
  bar.className = 'tile-bar'
  const barFill = document.createElement('div')
  barFill.className = 'tile-bar-fill'
  bar.appendChild(barFill)
  const foot = document.createElement('div')
  foot.className = 'tile-foot'
  root.append(img, skel, label, chip, cancel, stop, bar, foot)
  const node: TileNodes = {
    root, img, skel, label, chip, cancel, stop, bar, barFill, foot,
    rect: { x: 0, y: 0, sizeX: 0, sizeY: 0 },
    imgSrc: '',
    imgLoaded: false,
    imgFailed: false,
    entry: spring(0, 1),
    marked: false,
  }
  img.addEventListener('load', () => {
    node.imgLoaded = true
    node.imgFailed = false
    scheduleRender()
  })
  img.addEventListener('error', () => {
    // A thumb that 404s/aborts must not shimmer forever: flip to the error slab. A later
    // frame-index bump resets this (updateNode clears imgFailed on src change).
    node.imgFailed = true
    scheduleRender()
  })
  canvas.appendChild(root)
  return node
}

function elapsedLabel(tile: Tile): string {
  if (tile.endedAt == null) return ''
  const sec = Math.max(0, Math.round((tile.endedAt - tile.startedAt) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`
}

function show(el: HTMLElement, on: boolean): void {
  el.style.display = on ? '' : 'none'
}

// Latest-state projection of one entry onto its node (spec §7.3 tile states, exhaustive).
function updateNode(node: TileNodes, entry: GalleryEntry): void {
  switch (entry.kind) {
    case 'pending': {
      const pending = entry.pending
      node.root.classList.add('pending')
      node.root.classList.remove('clickable', 'failed')
      show(node.img, false)
      show(node.skel, true)
      node.skel.classList.add('shimmer')
      show(node.label, true)
      node.label.textContent = pending.prompt.length > 64 ? `${pending.prompt.slice(0, 64)}…` : pending.prompt
      const chipText = pending.kind === 'starting' ? 'STARTING' : ''
      show(node.chip, chipText !== '')
      node.chip.textContent = chipText
      node.chip.classList.remove('danger')
      show(node.cancel, false)
      show(node.stop, false)
      show(node.bar, false)
      show(node.foot, false)
      return
    }
    case 'queued': {
      // A queued FIFO item (server truth): position badge + its own × cancel (A8).
      const item = entry.item
      node.root.classList.add('pending')
      node.root.classList.remove('clickable', 'failed')
      show(node.img, false)
      show(node.skel, true)
      node.skel.classList.add('shimmer')
      show(node.label, true)
      node.label.textContent = item.prompt.length > 64 ? `${item.prompt.slice(0, 64)}…` : item.prompt
      show(node.chip, true)
      node.chip.textContent = `QUEUED #${item.position}`
      node.chip.classList.remove('danger')
      show(node.cancel, true)
      show(node.stop, false)
      show(node.bar, false)
      show(node.foot, false)
      return
    }
    case 'session': {
      const tile = entry.tile
      node.root.classList.remove('pending')
      node.root.classList.toggle('clickable', tile.frames >= 1)
      node.root.classList.toggle('failed', tile.state === 'failed')
      show(node.cancel, false)
      // ◼ STOP (A13): rendering tiles only; hides once a stop is in flight (the
      // STOPPING chip takes over — the affordance and the request are one-shot).
      show(node.stop, tile.state === 'rendering' && !(tile.live != null && tile.live.substate === 'stopping'))
      show(node.label, false)

      const src = tile.frames >= 1 ? thumbUrl(tile.id, tile.frames) : ''
      if (src !== node.imgSrc) {
        // Keep the previous frame's pixels visible while a NEWER thumb loads (imgLoaded
        // stays true across index bumps); only the very first src shows the skeleton.
        const first = node.imgSrc === ''
        node.imgSrc = src
        node.imgFailed = false // a new index is a fresh request — re-earn the slab
        if (first) node.imgLoaded = false
        if (src !== '') node.img.src = src
      }
      const hasImage = src !== '' && !node.imgFailed && (node.imgLoaded || node.img.complete)
      show(node.img, src !== '' && !node.imgFailed)
      show(node.skel, !hasImage)
      // Shimmer means "loading"; a failed tile or a failed thumb shows the static slab.
      node.skel.classList.toggle('shimmer', tile.state !== 'failed' && !node.imgFailed)
      node.skel.classList.toggle('dead', node.imgFailed)

      let chipText = ''
      let danger = false
      switch (tile.state) {
        case 'rendering':
          if (tile.live != null && tile.live.substate === 'stopping') chipText = 'STOPPING'
          break
        case 'stopped':
          chipText = `◼ ${tile.frames} frames`
          break
        case 'failed':
          chipText = '✕ FAILED'
          danger = true
          break
        case 'imported':
          chipText = 'IMPORTED'
          break
        case 'done':
          break
      }
      node.chip.classList.toggle('danger', danger)
      node.chip.classList.toggle('hover-only', tile.state === 'imported')
      show(node.chip, chipText !== '')
      node.chip.textContent = chipText

      // Progress chrome, rendering only.
      if (tile.state === 'rendering') {
        const live = tile.live
        show(node.bar, true)
        if (live == null || live.substate === 'launching' || live.substate === 'loading_models') {
          show(node.label, true)
          node.label.textContent = live == null || live.substate === 'launching' ? 'warming up…' : 'loading models…'
          node.bar.classList.add('indeterminate')
          node.barFill.style.width = '30%'
        } else {
          // §16: phase 1 of a two-phase session shows 'underpainting…' over the same
          // progress bar — stepsTotal spans BOTH phases (server-honest), so the bar
          // walks continuously from underpaint into the finish.
          show(node.label, live.substate === 'underpainting')
          if (live.substate === 'underpainting') node.label.textContent = 'underpainting…'
          node.bar.classList.remove('indeterminate')
          node.bar.classList.toggle('pulse', live.substate === 'rendering' || live.substate === 'underpainting')
          const pct = live.stepsTotal > 0 ? (100 * live.step) / live.stepsTotal : 0
          node.barFill.style.width = `${pct}%`
        }
      } else {
        show(node.bar, false)
        node.bar.classList.remove('indeterminate', 'pulse')
      }

      // Hover footer: prompt (or the failure line for failed tiles).
      const footText =
        tile.state === 'failed' && tile.failExcerpt != null
          ? tile.failExcerpt.split('\n')[0]!
          : `${tile.scenes ?? tile.slug} · ${tile.frames}f${tile.endedAt != null ? ` · ${elapsedLabel(tile)}` : ''}`
      show(node.foot, true)
      node.foot.textContent = footText
      return
    }
  }
}

// Returns true while any entry spring is still animating.
export function renderGallery(state: CreateState, springSteps: number): boolean {
  const env = state.env
  const ready = state.boot.phase === 'ready'
  show(emptyEl, ready && state.tiles.length === 0 && state.pending == null && state.queue.length === 0)
  if (!ready) {
    // Boot loading/failed: evict everything (the shell shows skeletons / the fail card).
    for (const [key, node] of nodes) {
      node.root.remove()
      nodes.delete(key)
    }
    canvas.style.height = '0px'
    return false
  }

  const entries = deriveGallery(state.pending, state.queue, state.tiles)
  const source = makeMasonrySource(entries)
  const innerX = env.viewportX
  const cols = masonryColumnCount(innerX - 2 * feel.galleryPadX, feel.cardMinX, feel.minCols, feel.maxCols)
  const viewportY = env.viewportY - feel.barAreaY
  const config = {
    colFractions: uniformColumnFractions(cols),
    availableSizeX: innerX - 2 * feel.galleryPadX - feel.gap * (cols - 1),
    originX: feel.galleryPadX,
    contentTop: feel.galleryPadTop,
    gap: feel.gap,
  }
  const viewport = {
    scrollTop: state.scrollTop,
    sizeY: viewportY,
    lenienceY: feel.occlusionLenienceViewports * viewportY,
  }

  for (const node of nodes.values()) node.marked = false

  const groupTops: number[] = []
  let animating = false
  let firstVisible: { key: string; topY: number } | null = null

  const result = placeMasonry(
    source,
    config,
    viewport,
    (cursor) => {
      if (!cursor.inWindow) return
      const entry = entries[cursor.groupIndex]!
      const key = entryKey(entry)
      let node = nodes.get(key)
      if (node == null) {
        node = makeNode(key)
        nodes.set(key, node)
      }
      node.marked = true
      // COPY the cursor fields (never retain the cursor — it is poisoned after the walk).
      node.rect.x = cursor.x
      node.rect.y = cursor.y
      node.rect.sizeX = cursor.sizeX
      node.rect.sizeY = cursor.sizeY

      if (firstVisible == null && cursor.partiallyVisible) {
        firstVisible = { key, topY: groupTops[cursor.groupIndex]! }
      }

      if (state.env.reducedMotion) springGoToEnd(node.entry)
      for (let i = 0; i < springSteps; i++) springStep(node.entry)
      if (!springMostlyDone(node.entry)) animating = true
      const rise = (1 - node.entry.pos) * feel.tileEntryRiseY
      node.root.style.transform = `translate(${cursor.x}px, ${cursor.y + rise}px)`
      node.root.style.width = `${cursor.sizeX}px`
      node.root.style.height = `${cursor.sizeY}px`
      node.root.style.opacity = String(node.entry.pos)

      updateNode(node, entry)
    },
    (groupIndex, topY) => {
      groupTops[groupIndex] = topY
    },
  )

  for (const [key, node] of nodes) {
    if (!node.marked) {
      node.root.remove()
      nodes.delete(key)
    }
  }

  canvas.style.height = `${result.contentHeight}px`

  // Scroll anchoring: only while actually scrolled down — at the top, prepends are
  // MEANT to push content (the optimistic tile appears in view).
  const pin = state.anchorPin
  if (pin != null && state.scrollTop > 40) {
    const index = entries.findIndex((e) => entryKey(e) === pin.key)
    const topNow = index >= 0 ? groupTops[index] : undefined
    if (topNow != null && topNow !== pin.prevY) {
      const adjusted = anchorScrollAdjustment(state.scrollTop, topNow, pin.prevY)
      state.scrollTop = adjusted
      scroller.scrollTop = adjusted
    }
  }
  // (cast: TS control flow doesn't track assignments made inside the emit callback)
  const fv = firstVisible as { key: string; topY: number } | null
  state.anchorPin = fv == null ? null : { key: fv.key, prevY: fv.topY }

  return animating
}
