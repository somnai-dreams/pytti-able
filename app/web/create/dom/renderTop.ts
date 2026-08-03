// renderTop.ts — the toplayer root: orderSurfaces(surfaces(state)) once per frame; the
// ladder's order becomes z-index for every floating root (lightbox, popover, confirm,
// toast) — no portals, no per-surface mount gates. Owns the confirm and toast content;
// bar/lightbox modules own theirs.
import { spring, springGoToEnd, springMostlyDone, springStep } from '@kit/midui/motion'
import { orderSurfaces } from '@kit/toplayer/core'
import { findTile, type CreateState } from '../core/model'
import { surfaces } from '../core/surfaces'

let lightboxEl: HTMLElement
let popoverEl: HTMLElement
let maskEl: HTMLElement
let confirmEl: HTMLElement
let confirmTextEl: HTMLElement
let confirmNoteEl: HTMLElement
let toastEl: HTMLElement

const toastRise = spring(0)

export function initTop(els: {
  lightbox: HTMLElement
  popover: HTMLElement
  mask: HTMLElement
  confirm: HTMLElement
  confirmText: HTMLElement
  confirmNote: HTMLElement
  toast: HTMLElement
}): void {
  lightboxEl = els.lightbox
  popoverEl = els.popover
  maskEl = els.mask
  confirmEl = els.confirm
  confirmTextEl = els.confirmText
  confirmNoteEl = els.confirmNote
  toastEl = els.toast
}

const Z_BASE = 100

export function renderTop(state: CreateState, springSteps: number): boolean {
  // One flat ordered list; declaration order in the ladder is stacking order.
  const ordered = orderSurfaces(surfaces(state))
  let confirmOpen = false
  let toastOpen = false
  for (let i = 0; i < ordered.length; i++) {
    const surface = ordered[i]!
    const z = String(Z_BASE + surface.layer)
    switch (surface.view.type) {
      case 'lightbox':
        lightboxEl.style.zIndex = z
        break
      case 'popover':
        popoverEl.style.zIndex = z
        break
      case 'mask-editor':
        maskEl.style.zIndex = z // display/content is renderMask's — the ladder only stacks
        break
      case 'confirm': {
        confirmOpen = true
        confirmEl.style.zIndex = z
        switch (surface.view.kind) {
          case 'delete': {
            const tile = findTile(state.tiles, surface.view.sessionId)
            confirmTextEl.textContent = `delete ${surface.view.sessionId}?`
            confirmNoteEl.textContent =
              tile != null && tile.imported
                ? 'imported session — files stay on disk and reappear after a server restart'
                : 'frames, sidecar and artifacts are removed'
            break
          }
          case 'discard-mask':
            confirmTextEl.textContent = 'discard unsaved mask strokes?'
            confirmNoteEl.textContent = 'the saved mask (if any) is unchanged'
            break
        }
        break
      }
      case 'toast':
        toastOpen = true
        toastEl.style.zIndex = z
        toastEl.textContent = surface.view.text
        break
    }
  }

  confirmEl.style.display = confirmOpen ? '' : 'none'

  toastRise.dest = toastOpen ? 1 : 0
  if (state.env.reducedMotion) springGoToEnd(toastRise)
  for (let i = 0; i < springSteps; i++) springStep(toastRise)
  const t = toastRise.pos
  toastEl.style.display = toastOpen || t > 0.02 ? '' : 'none'
  toastEl.style.opacity = String(t)
  toastEl.style.transform = `translateX(-50%) translateY(${(1 - t) * 16}px)`

  return !springMostlyDone(toastRise)
}
