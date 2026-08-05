import { describe, expect, test } from 'bun:test'
import { defaultEnv } from '@kit/env/core'
import { feel } from './feel'
import type { InitAttachment } from './init'
import {
  applyEncodeEvent,
  applyFrameEvent,
  applyProgressEvent,
  applyQueueEvent,
  applyStateEvent,
  type CreateState,
  dropUnreadableMask,
  failSubmission,
  findTile,
  insertTile,
  openMaskEditor,
  reconcileSessions,
  removeTile,
  showToast,
  type Tile,
} from './model'

function tile(id: string, over: Partial<Tile> = {}): Tile {
  return {
    id,
    slug: id,
    scenes: 'prompt for ' + id,
    state: 'done',
    seed: 1,
    startedAt: 1000,
    endedAt: 2000,
    frames: 10,
    stepsDone: 200,
    stepsTotal: 200,
    sizeX: 512,
    sizeY: 512,
    legacyDims: false,
    forkedFrom: null,
    imported: false,
    artifacts: [],
    failExcerpt: null,
    live: null,
    detail: null,
    ...over,
  }
}

function state(over: Partial<CreateState> = {}): CreateState {
  return {
    boot: { phase: 'ready' },
    env: defaultEnv(),
    schemaFields: ['scenes'],
    tiles: [],
    pending: null,
    queue: null,
    composer: { prompt: '', aspect: '1:1', quality: 'standard', look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null, popoverOpen: false },
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

describe('insertTile / findTile / removeTile', () => {
  test('inserts by startedAt desc and replaces same id', () => {
    const s = state({ tiles: [tile('a', { startedAt: 3000 }), tile('b', { startedAt: 1000 })] })
    insertTile(s, tile('c', { startedAt: 2000 }))
    expect(s.tiles.map((t) => t.id)).toEqual(['a', 'c', 'b'])
    insertTile(s, tile('c', { startedAt: 2000, frames: 99 }))
    expect(s.tiles.map((t) => t.id)).toEqual(['a', 'c', 'b'])
    expect(findTile(s.tiles, 'c')!.frames).toBe(99)
  })

  test('newest lands first; clears a pending that tracks the same id', () => {
    const s = state({
      tiles: [tile('a', { startedAt: 3000 })],
      pending: { kind: 'starting', id: 'new', prompt: 'p', sizeX: 512, sizeY: 512, deadline: 99 },
    })
    insertTile(s, tile('new', { startedAt: 5000 }))
    expect(s.tiles[0]!.id).toBe('new')
    expect(s.pending).toBeNull()
  })

  test('removeTile closes a lightbox showing it', () => {
    const s = state({
      tiles: [tile('a')],
      lightbox: { sessionId: 'a', frame: 3, swipe: { direction: 'still', accumulated: 0 }, anchor: { x: 0, y: 0, sizeX: 1, sizeY: 1 } },
    })
    removeTile(s, 'a')
    expect(s.tiles).toHaveLength(0)
    expect(s.lightbox).toBeNull()
  })
})

describe('applyStateEvent', () => {
  test('unknown session -> fetch-session follow-up', () => {
    const s = state()
    expect(applyStateEvent(s, { kind: 'state-live', sessionId: 'x', substate: 'launching' }, 5000)).toEqual({
      kind: 'fetch-session',
      sessionId: 'x',
    })
  })

  test('live substate creates telemetry and claims a matching pending', () => {
    const s = state({
      tiles: [tile('a', { state: 'stopped', endedAt: 9 })],
      pending: { kind: 'starting', id: 'a', prompt: 'p', sizeX: 512, sizeY: 512, deadline: 1 },
    })
    const follow = applyStateEvent(s, { kind: 'state-live', sessionId: 'a', substate: 'loading_models' }, 5000)
    expect(follow.kind).toBe('none')
    const t = s.tiles[0]!
    expect(t.state).toBe('rendering')
    expect(t.endedAt).toBeNull()
    expect(t.live!.substate).toBe('loading_models')
    expect(s.pending).toBeNull()
  })

  test('terminal settles the tile and freezes a following lightbox', () => {
    const s = state({
      tiles: [tile('a', { state: 'rendering', live: { substate: 'rendering', step: 1, stepsTotal: 2, scene: 0, sceneCount: 1, phase: 'scene', sPerStep: 1, etaSec: 1 } })],
      lightbox: { sessionId: 'a', frame: 'follow', swipe: { direction: 'still', accumulated: 0 }, anchor: { x: 0, y: 0, sizeX: 1, sizeY: 1 } },
    })
    const follow = applyStateEvent(
      s,
      { kind: 'state-terminal', sessionId: 'a', state: 'done', seed: 77, summary: { steps: 200, frames: 30, elapsedSec: 60 } },
      5000,
    )
    expect(follow.kind).toBe('none')
    const t = s.tiles[0]!
    expect(t.state).toBe('done')
    expect(t.live).toBeNull()
    expect(t.frames).toBe(30)
    expect(t.stepsDone).toBe(200)
    expect(t.seed).toBe(77)
    expect(t.endedAt).toBe(5000)
    expect(s.lightbox!.frame).toBe(30)
  })

  test('failed asks for the failExcerpt refetch', () => {
    const s = state({ tiles: [tile('a', { state: 'rendering' })] })
    expect(
      applyStateEvent(s, { kind: 'state-terminal', sessionId: 'a', state: 'failed', seed: null, summary: { steps: 3, frames: 0, elapsedSec: 2 } }, 1),
    ).toEqual({ kind: 'fetch-fail-excerpt', sessionId: 'a' })
  })
})

describe('applyProgressEvent / applyFrameEvent', () => {
  test('progress fills telemetry even when live was null (reconnect case)', () => {
    const s = state({ tiles: [tile('a', { state: 'rendering', live: null })] })
    applyProgressEvent(s, { kind: 'progress', sessionId: 'a', step: 50, stepsTotal: 200, scene: 0, sceneCount: 2, phase: 'scene', sPerStep: 1.1, etaSec: 165 })
    const t = s.tiles[0]!
    expect(t.live!.step).toBe(50)
    expect(t.live!.substate).toBe('rendering')
    expect(t.stepsDone).toBe(50)
  })

  test('progress after stopping keeps the stopping substate (the chip persists)', () => {
    const s = state({
      tiles: [tile('a', { state: 'rendering', live: { substate: 'stopping', step: 40, stepsTotal: 200, scene: 0, sceneCount: 1, phase: 'scene', sPerStep: 1, etaSec: 160 } })],
    })
    applyProgressEvent(s, { kind: 'progress', sessionId: 'a', step: 41, stepsTotal: 200, scene: 0, sceneCount: 1, phase: 'scene', sPerStep: 1, etaSec: 159 })
    const live = s.tiles[0]!.live!
    expect(live.substate).toBe('stopping') // spec §6.2: progress updates telemetry ONLY
    expect(live.step).toBe(41)
    expect(live.etaSec).toBe(159)
  })

  test('frame bumps the derived-thumb counter; unknown ids ignored', () => {
    const s = state({ tiles: [tile('a', { frames: 3 })] })
    applyFrameEvent(s, { kind: 'frame', sessionId: 'a', savedTotal: 4 })
    expect(s.tiles[0]!.frames).toBe(4)
    applyFrameEvent(s, { kind: 'frame', sessionId: 'zzz', savedTotal: 9 })
    expect(s.tiles[0]!.frames).toBe(4)
  })
})

describe('applyQueueEvent (Q-rules)', () => {
  test('Q1: slot drains while ours is queued -> starting with a grace deadline', () => {
    const s = state({ pending: { kind: 'queued', id: 'q1', prompt: 'p', sizeX: 640, sizeY: 360 } })
    applyQueueEvent(s, { kind: 'queue', queued: null }, 1000)
    expect(s.pending).toEqual({ kind: 'starting', id: 'q1', prompt: 'p', sizeX: 640, sizeY: 360, deadline: 1000 + feel.startingGraceMs })
    expect(s.queue).toBeNull()
  })

  test('Q2: replaced externally -> pending dropped + toast', () => {
    const s = state({ pending: { kind: 'queued', id: 'q1', prompt: 'p', sizeX: 512, sizeY: 512 } })
    applyQueueEvent(s, { kind: 'queue', queued: { id: 'q2', slug: 'other' } }, 1000)
    expect(s.pending).toBeNull()
    expect(s.toast!.text).toContain('replaced')
  })

  test('Q3: queued from the bench -> synthesized pending from the slug', () => {
    const s = state()
    applyQueueEvent(s, { kind: 'queue', queued: { id: 'q9', slug: 'bench-render' } }, 1000)
    expect(s.pending).toEqual({ kind: 'queued', id: 'q9', prompt: 'bench-render', sizeX: 512, sizeY: 512 })
  })

  test('our own 202 echo (same id) is a no-op', () => {
    const s = state({ pending: { kind: 'queued', id: 'q1', prompt: 'p', sizeX: 512, sizeY: 512 } })
    applyQueueEvent(s, { kind: 'queue', queued: { id: 'q1', slug: 'p' } }, 1000)
    expect(s.pending).toEqual({ kind: 'queued', id: 'q1', prompt: 'p', sizeX: 512, sizeY: 512 })
    expect(s.toast).toBeNull()
  })
})

describe('applyEncodeEvent', () => {
  const dl = { jobId: 'enc-1', sessionId: 'a', framesDone: 0, framesTotal: 0 }
  test('running updates progress; other jobs ignored', () => {
    const s = state({ download: { ...dl } })
    applyEncodeEvent(s, { kind: 'encode', jobId: 'enc-2', sessionId: 'a', framesDone: 5, framesTotal: 9, state: 'running', outUrl: null }, 0)
    expect(s.download!.framesDone).toBe(0)
    applyEncodeEvent(s, { kind: 'encode', jobId: 'enc-1', sessionId: 'a', framesDone: 5, framesTotal: 9, state: 'running', outUrl: null }, 0)
    expect(s.download!.framesDone).toBe(5)
  })
  test('done -> download-and-refresh follow-up, slot cleared', () => {
    const s = state({ download: { ...dl } })
    const follow = applyEncodeEvent(s, { kind: 'encode', jobId: 'enc-1', sessionId: 'a', framesDone: 9, framesTotal: 9, state: 'done', outUrl: '/api/out' }, 0)
    expect(follow).toEqual({ kind: 'download-and-refresh', sessionId: 'a', outUrl: '/api/out' })
    expect(s.download).toBeNull()
  })
  test('failed -> toast + slot cleared', () => {
    const s = state({ download: { ...dl } })
    applyEncodeEvent(s, { kind: 'encode', jobId: 'enc-1', sessionId: 'a', framesDone: 0, framesTotal: 9, state: 'failed', outUrl: null }, 7)
    expect(s.download).toBeNull()
    expect(s.toast!.text).toContain('failed')
    expect(s.toast!.expiresAt).toBe(7 + feel.toastMs)
  })
})

describe('reconcileSessions', () => {
  test('fresh wins; live carries only while still rendering; detail always carries', () => {
    const live = { substate: 'rendering' as const, step: 5, stepsTotal: 9, scene: 0, sceneCount: 1, phase: 'scene' as const, sPerStep: 1, etaSec: 4 }
    const s = state({
      tiles: [
        tile('a', { state: 'rendering', live, detail: { seed: 1 } }),
        tile('b', { state: 'rendering', live, detail: { seed: 2 } }),
        tile('gone'),
      ],
    })
    reconcileSessions(s, [tile('a', { state: 'rendering', frames: 12 }), tile('b', { state: 'done' }), tile('new')])
    expect(s.tiles.map((t) => t.id)).toEqual(['a', 'b', 'new'])
    expect(s.tiles[0]!.live).toBe(live)
    expect(s.tiles[0]!.detail).toEqual({ seed: 1 })
    expect(s.tiles[0]!.frames).toBe(12)
    expect(s.tiles[1]!.live).toBeNull() // fresh says done — stale telemetry must not survive
    expect(s.tiles[1]!.detail).toEqual({ seed: 2 }) // snapshots are immutable
  })

  test('a lightbox open on a dropped session closes with it (no render-loop throw)', () => {
    const s = state({
      tiles: [tile('x'), tile('keep')],
      lightbox: { sessionId: 'x', frame: 3, swipe: { direction: 'still', accumulated: 0 }, anchor: { x: 0, y: 0, sizeX: 1, sizeY: 1 } },
    })
    reconcileSessions(s, [tile('keep')])
    expect(s.tiles.map((t) => t.id)).toEqual(['keep'])
    expect(s.lightbox).toBeNull()
  })

  test('lightbox and confirm survive when their session survives; confirm on a dropped id closes', () => {
    const s = state({
      tiles: [tile('x'), tile('keep')],
      lightbox: { sessionId: 'keep', frame: 1, swipe: { direction: 'still', accumulated: 0 }, anchor: { x: 0, y: 0, sizeX: 1, sizeY: 1 } },
      confirm: { kind: 'delete', sessionId: 'x' },
    })
    reconcileSessions(s, [tile('keep')])
    expect(s.lightbox!.sessionId).toBe('keep')
    expect(s.confirm).toBeNull()
  })

  test('a discard-mask confirm has no session and survives a resync (§15.3)', () => {
    const s = state({ tiles: [tile('x')], confirm: { kind: 'discard-mask' } })
    reconcileSessions(s, [])
    expect(s.confirm).toEqual({ kind: 'discard-mask' })
  })
})

describe('failSubmission', () => {
  test('queue mirror still holds a slot -> pending restored as its queued tile (no queue lie)', () => {
    const s = state({
      queue: { id: 'q-old', slug: 'previous-render' },
      pending: { kind: 'posting', prompt: 'replacement', sizeX: 640, sizeY: 360 },
    })
    failSubmission(s)
    expect(s.pending).toEqual({ kind: 'queued', id: 'q-old', prompt: 'previous-render', sizeX: 512, sizeY: 512 })
  })

  test('empty queue mirror -> pending clears', () => {
    const s = state({ pending: { kind: 'posting', prompt: 'p', sizeX: 512, sizeY: 512 } })
    failSubmission(s)
    expect(s.pending).toBeNull()
  })
})

describe('showToast', () => {
  test('deadline as data', () => {
    const s = state()
    showToast(s, 'hi', 100)
    expect(s.toast).toEqual({ text: 'hi', expiresAt: 100 + feel.toastMs })
  })
})

function readyInit(over: Partial<InitAttachment> = {}): InitAttachment {
  return {
    image: { kind: 'ready', name: 'img.png', path: '/uploads/img.png', localUrl: null },
    strength: 'medium',
    holdMeaning: false,
    mask: null,
    ...over,
  }
}

describe('openMaskEditor (§15.7)', () => {
  test('opens with defaults, closes the popover, seeds inverted from the existing mask', () => {
    const s = state()
    s.composer.init = readyInit({ mask: { path: '/uploads/mask-img.png', inverted: true } })
    s.composer.popoverOpen = true
    expect(openMaskEditor(s)).toBe(true)
    expect(s.maskEditor).toEqual({
      brushSize: feel.maskBrushDefault,
      mode: 'paint',
      inverted: true,
      dirty: false,
      saving: false,
    })
    expect(s.composer.popoverOpen).toBe(false)
  })

  test('re-entry is a no-op: the open editor and its unsaved-strokes flag survive', () => {
    // Regression: Space/Enter on the still-focused MASK button replaced the editor
    // object — dirty reset to false, unsaved strokes wiped past the discard confirm.
    const s = state()
    s.composer.init = readyInit()
    expect(openMaskEditor(s)).toBe(true)
    const editor = s.maskEditor!
    editor.dirty = true
    editor.mode = 'erase'
    expect(openMaskEditor(s)).toBe(false)
    expect(s.maskEditor).toBe(editor)
    expect(editor.dirty).toBe(true)
    expect(editor.mode).toBe('erase')
  })

  test('no attachment or still-uploading image -> no-op (the chip disables MASK)', () => {
    const s = state()
    expect(openMaskEditor(s)).toBe(false)
    expect(s.maskEditor).toBeNull()
    s.composer.init = readyInit({ image: { kind: 'uploading', name: 'img.png', localUrl: 'blob:x' } })
    expect(openMaskEditor(s)).toBe(false)
    expect(s.maskEditor).toBeNull()
  })
})

describe('dropUnreadableMask (§15.7)', () => {
  test('the dead path leaves composer state with the toast; the editor stays open blank', () => {
    // Regression: an unreadable existing mask fail-softed in the editor display only —
    // init.mask kept the dead path, and an invert-only SAVE or a clean close re-emitted
    // it into the next submit.
    const s = state()
    s.composer.init = readyInit({ mask: { path: '/uploads/mask-gone.png', inverted: false } })
    expect(openMaskEditor(s)).toBe(true)
    dropUnreadableMask(s)
    expect(s.composer.init!.mask).toBeNull()
    expect(s.maskEditor).not.toBeNull()
  })

  test('throws outside an open editor (invariant violation, fail loud)', () => {
    const s = state()
    expect(() => dropUnreadableMask(s)).toThrow('dropUnreadableMask outside an open mask editor')
  })
})
