// @cs
// create/core/surfaces: the Z-ladder (declaration order IS stacking order) and the
// per-frame surface list — floating UI as data, rendered once at the root through
// kit/toplayer orderSurfaces. Popover and lightbox are mutually exclusive by construction
// (opening one closes the other), and the mask editor closes the popover on open (§15.7)
// — but the ladder still totally orders them.
//
// String/JSON domain — outside freerange's numeric subset; surfaces.test.ts is the
// checked surface.
//
//   zLightbox < zPopover < zMaskEditor < zConfirm < zToast
//   CreateView — the surface payload union (data, never a framework node)
//   surfaces(state) -> Surface<CreateView>[]
//   topmostDismissable(state) -> 'confirm' | 'mask-editor' | 'popover' | 'lightbox' | null
//     Esc dismisses exactly that one; toasts are not Esc-dismissable (wake loop expiry)
// @/cs
import type { Surface } from '@kit/toplayer/core'
import type { CreateState } from './model'

let d = 1
export const zLightbox = d++
export const zPopover = d++
export const zMaskEditor = d++
export const zConfirm = d++
export const zToast = d++

export type CreateView =
  | { type: 'lightbox' } // payload read from state at render
  | { type: 'popover' }
  | { type: 'mask-editor' } // payload (canvas scratch) lives at the dom surface
  | { type: 'confirm'; kind: 'delete'; sessionId: string }
  | { type: 'confirm'; kind: 'discard-mask' }
  | { type: 'toast'; text: string }

export function surfaces(state: CreateState): Surface<CreateView>[] {
  const out: Surface<CreateView>[] = []
  if (state.lightbox != null) out.push({ key: 'lightbox', layer: zLightbox, view: { type: 'lightbox' } })
  if (state.composer.popoverOpen) out.push({ key: 'popover', layer: zPopover, view: { type: 'popover' } })
  if (state.maskEditor != null) out.push({ key: 'mask-editor', layer: zMaskEditor, view: { type: 'mask-editor' } })
  const confirm = state.confirm
  if (confirm != null) {
    switch (confirm.kind) {
      case 'delete':
        out.push({
          key: 'confirm',
          layer: zConfirm,
          view: { type: 'confirm', kind: 'delete', sessionId: confirm.sessionId },
        })
        break
      case 'discard-mask':
        out.push({ key: 'confirm', layer: zConfirm, view: { type: 'confirm', kind: 'discard-mask' } })
        break
    }
  }
  if (state.toast != null) out.push({ key: 'toast', layer: zToast, view: { type: 'toast', text: state.toast.text } })
  return out
}

export function topmostDismissable(
  state: CreateState,
): 'confirm' | 'mask-editor' | 'popover' | 'lightbox' | null {
  if (state.confirm != null) return 'confirm'
  if (state.maskEditor != null) return 'mask-editor'
  if (state.composer.popoverOpen) return 'popover'
  if (state.lightbox != null) return 'lightbox'
  return null
}
