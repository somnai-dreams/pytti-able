import { describe, expect, test } from 'bun:test'
import { defaultEnv } from '@kit/env/core'
import { orderSurfaces } from '@kit/toplayer/core'
import type { CreateState } from './model'
import { surfaces, topmostDismissable, zConfirm, zLightbox, zMaskEditor, zPopover, zToast } from './surfaces'

function state(over: Partial<CreateState> = {}): CreateState {
  return {
    boot: { phase: 'ready' },
    env: defaultEnv(),
    schemaFields: [],
    tiles: [],
    pending: null,
    queue: [],
    composer: { prompt: '', aspect: '1:1', size: 'full', steps: 200, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null, popoverOpen: false },
    lastRun: null,
    lastSeed: null,
    lightbox: null,
    maskEditor: null,
    confirm: null,
    toast: null,
    download: null,
    sse: { phase: 'open' },
    scrollTop: 0,
    anchorPin: null,
    now: 0,
    ...over,
  }
}

const lightbox = { sessionId: 'a', frame: 1 as const, swipe: { direction: 'still' as const, accumulated: 0 }, anchor: { x: 0, y: 0, sizeX: 1, sizeY: 1 } }

describe('the Z-ladder', () => {
  test('declaration order is stacking order', () => {
    expect(zLightbox < zPopover && zPopover < zMaskEditor && zMaskEditor < zConfirm && zConfirm < zToast).toBe(true)
  })
})

describe('surfaces', () => {
  test('empty state -> no surfaces', () => {
    expect(surfaces(state())).toEqual([])
  })
  test('all five, ordered by the ladder through orderSurfaces', () => {
    const s = state({
      lightbox,
      maskEditor: { brushSize: 48, mode: 'paint', inverted: false, dirty: false, saving: false },
      confirm: { kind: 'delete', sessionId: 'a' },
      toast: { text: 'hi', expiresAt: 1 },
    })
    s.composer.popoverOpen = true
    const ordered = orderSurfaces(surfaces(s))
    expect(ordered.map((x) => x.view.type)).toEqual(['lightbox', 'popover', 'mask-editor', 'confirm', 'toast'])
  })
  test('confirm carries its payload', () => {
    const s = state({ confirm: { kind: 'delete', sessionId: 's-9' } })
    expect(surfaces(s)[0]!.view).toEqual({ type: 'confirm', kind: 'delete', sessionId: 's-9' })
  })
  test('discard-mask confirm has no session payload', () => {
    const s = state({ confirm: { kind: 'discard-mask' } })
    expect(surfaces(s)[0]!.view).toEqual({ type: 'confirm', kind: 'discard-mask' })
  })
})

describe('topmostDismissable (Esc order)', () => {
  test('confirm > popover > lightbox > null; toasts are never Esc-dismissable', () => {
    const s = state({
      lightbox,
      maskEditor: { brushSize: 48, mode: 'paint', inverted: false, dirty: false, saving: false },
      confirm: { kind: 'delete', sessionId: 'a' },
      toast: { text: 'x', expiresAt: 1 },
    })
    s.composer.popoverOpen = true
    expect(topmostDismissable(s)).toBe('confirm')
    s.confirm = null
    expect(topmostDismissable(s)).toBe('mask-editor') // §15.7: above popover, below confirm
    s.maskEditor = null
    expect(topmostDismissable(s)).toBe('popover')
    s.composer.popoverOpen = false
    expect(topmostDismissable(s)).toBe('lightbox')
    s.lightbox = null
    expect(topmostDismissable(s)).toBeNull() // the toast alone dismisses nothing
  })
})
