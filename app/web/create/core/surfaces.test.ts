import { describe, expect, test } from 'bun:test'
import { defaultEnv } from '@kit/env/core'
import { orderSurfaces } from '@kit/toplayer/core'
import type { CreateState } from './model'
import { surfaces, topmostDismissable, zConfirm, zLightbox, zPopover, zToast } from './surfaces'

function state(over: Partial<CreateState> = {}): CreateState {
  return {
    boot: { phase: 'ready' },
    env: defaultEnv(),
    draftFields: [],
    tiles: [],
    pending: null,
    queue: null,
    composer: { prompt: '', aspect: '1:1', quality: 'standard', look: 'limited', seedMode: { kind: 'random' }, tweak: null, popoverOpen: false },
    lastRun: null,
    lastSeed: null,
    lightbox: null,
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
    expect(zLightbox < zPopover && zPopover < zConfirm && zConfirm < zToast).toBe(true)
  })
})

describe('surfaces', () => {
  test('empty state -> no surfaces', () => {
    expect(surfaces(state())).toEqual([])
  })
  test('all four, ordered by the ladder through orderSurfaces', () => {
    const s = state({
      lightbox,
      confirm: { kind: 'delete', sessionId: 'a' },
      toast: { text: 'hi', expiresAt: 1 },
    })
    s.composer.popoverOpen = true
    const ordered = orderSurfaces(surfaces(s))
    expect(ordered.map((x) => x.view.type)).toEqual(['lightbox', 'popover', 'confirm', 'toast'])
  })
  test('confirm carries its payload', () => {
    const s = state({ confirm: { kind: 'delete', sessionId: 's-9' } })
    expect(surfaces(s)[0]!.view).toEqual({ type: 'confirm', kind: 'delete', sessionId: 's-9' })
  })
})

describe('topmostDismissable (Esc order)', () => {
  test('confirm > popover > lightbox > null; toasts are never Esc-dismissable', () => {
    const s = state({ lightbox, confirm: { kind: 'delete', sessionId: 'a' }, toast: { text: 'x', expiresAt: 1 } })
    s.composer.popoverOpen = true
    expect(topmostDismissable(s)).toBe('confirm')
    s.confirm = null
    expect(topmostDismissable(s)).toBe('popover')
    s.composer.popoverOpen = false
    expect(topmostDismissable(s)).toBe('lightbox')
    s.lightbox = null
    expect(topmostDismissable(s)).toBeNull() // the toast alone dismisses nothing
  })
})
