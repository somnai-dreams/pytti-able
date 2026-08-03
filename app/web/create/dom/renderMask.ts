// renderMask.ts — the paint surface (spec §15.7): a toplayer at zMaskEditor with the
// init image at fit size, an offscreen paint canvas at the image's NATURAL resolution
// (dom scratch beside the store — the pixels are never state), pointer strokes stamped
// through core/mask geometry, an accent tint overlay that ALWAYS shows the hold region
// (INVERT flips the flag, not the pixels), and the white-on-black PNG export + upload.
// All geometry from data (env + natural size + feel) — no DOM measurement.
import { spring, springGoToEnd, springMostlyDone, springStep } from '@kit/midui/motion'
import { center, fit } from '@kit/midui/num'
import { uploadUrl } from '../core/api'
import { feel } from '../core/feel'
import type { InitAttachment } from '../core/init'
import { clampBrushSize, strokeStamps, viewToImage } from '../core/mask'
import { type CreateState, dropUnreadableMask } from '../core/model'
import { uploadFile } from './net'

const ACCENT = '#00e5ff' // create.css --accent; tint alpha lives on the overlay's CSS

type MaskEls = {
  root: HTMLElement
  scrim: HTMLElement
  stage: HTMLElement
  img: HTMLImageElement
  overlay: HTMLCanvasElement
  paintBtn: HTMLButtonElement
  eraseBtn: HTMLButtonElement
  invertBtn: HTMLButtonElement
  clearBtn: HTMLButtonElement
  brush: HTMLInputElement
  removeBtn: HTMLButtonElement
  saveBtn: HTMLButtonElement
}

type MaskDeps = {
  state: CreateState // handlers read state at event time (kit doctrine rule 6)
  scheduleRender: () => void
  toast: (text: string) => void
  requestClose: () => void // scrim click — same rule as Esc (dirty -> discard confirm)
}

// --- dom scratch beside the store (precedent: lightbox double-buffer bookkeeping)
type PaintSurface = {
  imgSizeX: number
  imgSizeY: number
  paint: HTMLCanvasElement // white strokes on transparent; composited onto black at save
  pctx: CanvasRenderingContext2D
  ready: boolean // false until any existing mask resolved — strokes wait
}
let surface: PaintSurface | null = null
let overlayDirty = false
let stroke: { lastX: number; lastY: number } | null = null // image-space
let els: MaskEls
let deps: MaskDeps
const t = spring(0)

function mustCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (ctx == null) throw new Error('2d canvas context unavailable')
  return ctx
}

function resetScratch(): void {
  surface = null
  stroke = null
  overlayDirty = false
  els.img.removeAttribute('src')
}

// The fit rect, from data: viewport minus margins and the bottom toolbar band (§15.7).
function fitRect(state: CreateState, s: PaintSurface): { x: number; y: number; sizeX: number; sizeY: number } {
  const areaX = state.env.viewportX - 2 * feel.maskEditorMargin
  const areaY = state.env.viewportY - 2 * feel.maskEditorMargin - feel.maskToolbarY
  const ar = s.imgSizeX / s.imgSizeY
  const sizeX = fit(ar, areaX, areaY)
  const sizeY = sizeX / ar
  return {
    x: feel.maskEditorMargin + center(sizeX, areaX),
    y: feel.maskEditorMargin + center(sizeY, areaY),
    sizeX,
    sizeY,
  }
}

// Open the dom side of the editor for an attachment. main sets state.maskEditor first;
// the image (and any existing mask PNG) loads async — strokes are inert until ready.
export function openMaskSurface(init: InitAttachment): void {
  if (init.image.kind !== 'ready') {
    throw new Error('openMaskSurface while image uploading (the chip disables MASK)')
  }
  resetScratch()
  els.img.src = init.image.localUrl ?? uploadUrl(init.image.path)
}

function onImageLoaded(): void {
  if (deps.state.maskEditor == null) return // closed before the load landed
  const sizeX = els.img.naturalWidth
  const sizeY = els.img.naturalHeight
  if (sizeX < 1 || sizeY < 1) throw new Error('mask editor image loaded with zero natural size')
  const paint = document.createElement('canvas')
  paint.width = sizeX
  paint.height = sizeY
  const created: PaintSurface = { imgSizeX: sizeX, imgSizeY: sizeY, paint, pctx: mustCtx(paint), ready: false }
  surface = created
  els.overlay.width = sizeX
  els.overlay.height = sizeY
  const init = deps.state.composer.init
  if (init == null) throw new Error('mask editor open without an attachment')
  if (init.mask == null) {
    created.ready = true
    overlayDirty = true
    deps.scheduleRender()
  } else {
    loadExistingMask(created, init.mask.path)
  }
}

// Draw the existing white-on-black mask PNG into the paint canvas as white-on-ALPHA
// (alpha = luminance x source alpha) so erase/tint semantics keep working. Load failure
// fail-softs (§15.7): toast + blank canvas + init.mask dropped in the same transition —
// a dead path left on the composer would ride an invert-only SAVE or the next submit.
function loadExistingMask(target: PaintSurface, path: string): void {
  const maskImg = new Image()
  maskImg.onload = () => {
    if (surface !== target || deps.state.maskEditor == null) return
    target.pctx.drawImage(maskImg, 0, 0, target.imgSizeX, target.imgSizeY)
    const data = target.pctx.getImageData(0, 0, target.imgSizeX, target.imgSizeY)
    const px = data.data
    for (let i = 0; i < px.length; i += 4) {
      const luminance = px[i]!
      const alpha = px[i + 3]!
      px[i] = 255
      px[i + 1] = 255
      px[i + 2] = 255
      px[i + 3] = Math.round((luminance * alpha) / 255)
    }
    target.pctx.putImageData(data, 0, 0)
    target.ready = true
    overlayDirty = true
    deps.scheduleRender()
  }
  maskImg.onerror = () => {
    if (surface !== target || deps.state.maskEditor == null) return
    deps.toast('existing mask not readable — starting blank')
    dropUnreadableMask(deps.state) // what the user sees (blank, no mask) is what submits
    target.ready = true
    overlayDirty = true
    deps.scheduleRender()
  }
  maskImg.src = uploadUrl(path)
}

function stamp(s: PaintSurface, mode: 'paint' | 'erase', x: number, y: number, radius: number): void {
  const g = s.pctx
  g.globalCompositeOperation = mode === 'paint' ? 'source-over' : 'destination-out'
  g.fillStyle = '#ffffff'
  g.beginPath()
  g.arc(x, y, radius, 0, Math.PI * 2)
  g.fill()
}

function onPointerDown(e: PointerEvent): void {
  const editor = deps.state.maskEditor
  const s = surface
  if (editor == null || s == null || !s.ready || editor.saving) return
  els.overlay.setPointerCapture(e.pointerId)
  const r = fitRect(deps.state, s)
  const scale = s.imgSizeX / r.sizeX
  const p = viewToImage(e.clientX, e.clientY, r.x, r.y, r.sizeX, s.imgSizeX)
  stamp(s, editor.mode, p.x, p.y, (editor.brushSize * scale) / 2)
  stroke = { lastX: p.x, lastY: p.y }
  editor.dirty = true
  overlayDirty = true
  deps.scheduleRender()
}

function onPointerMove(e: PointerEvent): void {
  const editor = deps.state.maskEditor
  const s = surface
  const active = stroke
  if (editor == null || s == null || active == null) return
  const r = fitRect(deps.state, s)
  const scale = s.imgSizeX / r.sizeX
  const p = viewToImage(e.clientX, e.clientY, r.x, r.y, r.sizeX, s.imgSizeX)
  const spacing = Math.max(1, editor.brushSize * scale * feel.maskStampSpacingFrac)
  const stamps = strokeStamps(active.lastX, active.lastY, p.x, p.y, spacing)
  for (let i = 0; i < stamps.length; i += 2) {
    stamp(s, editor.mode, stamps[i]!, stamps[i + 1]!, (editor.brushSize * scale) / 2)
  }
  active.lastX = p.x
  active.lastY = p.y
  overlayDirty = true
  deps.scheduleRender()
}

function onPointerEnd(): void {
  stroke = null
}

function imageStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

// SAVE (§15.7): invert-only edits skip the re-upload; otherwise composite onto black,
// reject an all-empty mask, upload, and stamp the result onto init.mask. Failure keeps
// the editor open — painted work is never destroyed by a network error.
function saveMask(): void {
  const state = deps.state
  const editor = state.maskEditor
  const init = state.composer.init
  if (editor == null || init == null || editor.saving) return
  if (init.mask != null && !editor.dirty) {
    init.mask = { path: init.mask.path, inverted: editor.inverted }
    state.maskEditor = null
    deps.scheduleRender()
    return
  }
  const s = surface
  if (s == null || !s.ready) return
  const px = s.pctx.getImageData(0, 0, s.imgSizeX, s.imgSizeY).data
  let painted = false
  for (let i = 3; i < px.length; i += 4) {
    if (px[i]! > 0) {
      painted = true
      break
    }
  }
  if (!painted) {
    deps.toast('mask is empty — paint where the image should hold')
    return
  }
  editor.saving = true
  deps.scheduleRender()
  const out = document.createElement('canvas')
  out.width = s.imgSizeX
  out.height = s.imgSizeY
  const g = mustCtx(out)
  g.fillStyle = '#000000'
  g.fillRect(0, 0, out.width, out.height)
  g.drawImage(s.paint, 0, 0)
  const name = `mask-${imageStem(init.image.name)}.png`
  out.toBlob((blob) => {
    const editorNow = deps.state.maskEditor
    if (editorNow == null) return
    if (blob == null) {
      editorNow.saving = false
      deps.toast('mask export failed')
      deps.scheduleRender()
      return
    }
    void uploadFile(blob, name)
      .then((result) => {
        const editorAfter = deps.state.maskEditor
        if (editorAfter == null) return
        if (result.ok) {
          const initNow = deps.state.composer.init
          if (initNow != null) initNow.mask = { path: result.path, inverted: editorAfter.inverted }
          deps.state.maskEditor = null
        } else {
          editorAfter.saving = false
          deps.toast(result.message)
        }
        deps.scheduleRender()
      })
      .catch((err: unknown) => {
        console.error(err)
        const editorAfter = deps.state.maskEditor
        if (editorAfter != null) editorAfter.saving = false
        deps.toast('upload failed')
        deps.scheduleRender()
      })
  }, 'image/png')
}

// The tint overlay ALWAYS shows where the init holds: painted pixels when not inverted,
// everything else when inverted (the exported PNG is identical either way — the '-'
// goes inside the bracket at compose time).
function redrawOverlay(s: PaintSurface, inverted: boolean): void {
  const g = mustCtx(els.overlay)
  g.globalCompositeOperation = 'source-over'
  g.clearRect(0, 0, s.imgSizeX, s.imgSizeY)
  if (inverted) {
    g.fillStyle = ACCENT
    g.fillRect(0, 0, s.imgSizeX, s.imgSizeY)
    g.globalCompositeOperation = 'destination-out'
    g.drawImage(s.paint, 0, 0)
  } else {
    g.drawImage(s.paint, 0, 0)
    g.globalCompositeOperation = 'source-in'
    g.fillStyle = ACCENT
    g.fillRect(0, 0, s.imgSizeX, s.imgSizeY)
  }
}

export function initMask(d: MaskDeps, e: MaskEls): void {
  deps = d
  els = e
  els.img.addEventListener('load', onImageLoaded)
  els.img.addEventListener('error', () => {
    // The chip disables MASK when its thumb failed, so this is a race (file vanished
    // between chip render and open): fail soft, close — nothing paintable exists.
    if (deps.state.maskEditor == null) return
    deps.toast('init image not readable')
    deps.state.maskEditor = null
    deps.scheduleRender()
  })
  els.overlay.addEventListener('pointerdown', onPointerDown)
  els.overlay.addEventListener('pointermove', onPointerMove)
  els.overlay.addEventListener('pointerup', onPointerEnd)
  els.overlay.addEventListener('pointercancel', onPointerEnd)
  els.scrim.addEventListener('click', () => deps.requestClose())
  els.paintBtn.addEventListener('click', () => {
    const editor = deps.state.maskEditor
    if (editor == null) return
    editor.mode = 'paint'
    deps.scheduleRender()
  })
  els.eraseBtn.addEventListener('click', () => {
    const editor = deps.state.maskEditor
    if (editor == null) return
    editor.mode = 'erase'
    deps.scheduleRender()
  })
  els.invertBtn.addEventListener('click', () => {
    const editor = deps.state.maskEditor
    if (editor == null) return
    editor.inverted = !editor.inverted // flips the flag, not the pixels
    overlayDirty = true
    deps.scheduleRender()
  })
  els.clearBtn.addEventListener('click', () => {
    const editor = deps.state.maskEditor
    const s = surface
    if (editor == null || s == null || !s.ready || editor.saving) return
    s.pctx.clearRect(0, 0, s.imgSizeX, s.imgSizeY)
    editor.dirty = true
    overlayDirty = true
    deps.scheduleRender()
  })
  els.brush.addEventListener('input', () => {
    const editor = deps.state.maskEditor
    if (editor == null) return
    editor.brushSize = clampBrushSize(Number(els.brush.value), feel.maskBrushMin, feel.maskBrushMax)
    deps.scheduleRender()
  })
  els.removeBtn.addEventListener('click', () => {
    const state = deps.state
    const editor = state.maskEditor
    const init = state.composer.init
    if (editor == null || init == null || editor.saving) return
    init.mask = null
    state.maskEditor = null
    deps.scheduleRender()
  })
  els.saveBtn.addEventListener('click', saveMask)
}

// Returns true while the reveal spring is live.
export function renderMask(state: CreateState, springSteps: number): boolean {
  const editor = state.maskEditor
  if (editor != null && state.composer.init == null) {
    throw new Error('mask editor open without an attachment (unreachable by construction)')
  }

  t.dest = editor != null ? 1 : 0
  if (state.env.reducedMotion) springGoToEnd(t)
  else for (let i = 0; i < springSteps; i++) springStep(t)

  const active = editor != null || t.pos > 0.02
  els.root.style.display = active ? '' : 'none'
  if (!active) {
    if (surface != null) resetScratch() // released after the fade completes
    return false
  }
  els.root.style.opacity = String(Math.max(0, Math.min(1, t.pos)))

  const s = surface
  els.stage.style.display = s == null ? 'none' : ''
  if (editor != null && s != null) {
    const r = fitRect(state, s)
    els.stage.style.transform = `translate(${r.x}px, ${r.y}px)`
    els.stage.style.width = `${r.sizeX}px`
    els.stage.style.height = `${r.sizeY}px`
    if (overlayDirty) {
      redrawOverlay(s, editor.inverted)
      overlayDirty = false
    }
    els.paintBtn.classList.toggle('sel', editor.mode === 'paint')
    els.eraseBtn.classList.toggle('sel', editor.mode === 'erase')
    els.invertBtn.classList.toggle('sel', editor.inverted)
    if (els.brush.value !== String(editor.brushSize)) els.brush.value = String(editor.brushSize)
    const init = state.composer.init
    els.removeBtn.style.display = init != null && init.mask != null ? '' : 'none'
    els.saveBtn.disabled = editor.saving || !s.ready
    els.saveBtn.textContent = editor.saving ? 'SAVING…' : 'SAVE'
  }

  return !springMostlyDone(t)
}
