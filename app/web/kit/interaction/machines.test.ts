import { expect, test } from 'bun:test'
import {
  advancePillCursor,
  advancePillTooltip,
  coldPillCursor,
  coldPillTooltip,
  type PillCursorState,
  type PillInteractionTarget,
  type PillPointerRegion,
  type PillTooltipState,
} from './machines'

const CURSOR_BRIDGE = 1000
const TOOLTIP_ACTIVATION_DWELL = 250
const TOOLTIP_WARM_GRACE = 300
const pill = (
  ownerId: string,
  key: string,
  previewable = true,
  sourceId = 'masonry',
): PillPointerRegion => ({
  type: 'pill',
  target: { sourceId, ownerId, key },
  previewable,
})

function stepCursor(state: PillCursorState, region: PillPointerRegion, now: number) {
  return advancePillCursor(state, region, now, CURSOR_BRIDGE)
}

function stepTooltip(
  state: PillTooltipState,
  region: PillPointerRegion,
  now: number,
  moved = false,
) {
  return advancePillTooltip(state, region, now, moved, TOOLTIP_ACTIVATION_DWELL, TOOLTIP_WARM_GRACE)
}

function warmTooltip(target: PillInteractionTarget): PillTooltipState {
  return { type: 'warm', lastPreview: target, expiresAt: null, retainPreview: true }
}

test('every pill activates the cursor and starts a bridge on exit', () => {
  const plain = stepCursor(coldPillCursor, pill('a', 'ar', false), 100)
  expect(plain.state).toEqual({
    type: 'active',
    lastTarget: { type: 'pill', target: { sourceId: 'masonry', ownerId: 'a', key: 'ar' } },
    expiresAt: null,
    retainPill: true,
  })
  expect(plain.presentedPill).toEqual({ sourceId: 'masonry', ownerId: 'a', key: 'ar' })
  expect(plain.active).toBe(true)

  const outside = stepCursor(plain.state, { type: 'none' }, 200)
  expect(outside.state).toEqual({
    type: 'active',
    lastTarget: { type: 'pill', target: { sourceId: 'masonry', ownerId: 'a', key: 'ar' } },
    expiresAt: 1200,
    retainPill: false,
  })
  expect(outside.presentedPill).toBeNull()
  expect(outside.active).toBe(true)
  expect(stepCursor(outside.state, { type: 'none' }, 1199).active).toBe(true)
  expect(stepCursor(outside.state, { type: 'none' }, 1200).active).toBe(false)
})

test('prompt text participates in the cursor bridge without becoming a pill', () => {
  const promptText = stepCursor(
    coldPillCursor,
    { type: 'activation-target', target: { sourceId: 'masonry', ownerId: 'a', key: 'prompt-text' } },
    100,
  )
  expect(promptText.state).toEqual({
    type: 'active',
    lastTarget: {
      type: 'activation-target',
      target: { sourceId: 'masonry', ownerId: 'a', key: 'prompt-text' },
    },
    expiresAt: null,
    retainPill: false,
  })
  expect(promptText.presentedPill).toBeNull()
  expect(promptText.active).toBe(true)

  const gap = stepCursor(promptText.state, { type: 'surface', sourceId: 'masonry', ownerId: 'a' }, 150)
  expect(gap.active).toBe(true)
  expect(gap.nextDeadline).toBe(1150)

  const pillTarget = stepCursor(gap.state, pill('a', 'ar', false), 200)
  expect(pillTarget.presentedPill).toEqual({ sourceId: 'masonry', ownerId: 'a', key: 'ar' })
  expect(pillTarget.nextDeadline).toBeNull()

  const reverseGap = stepCursor(
    pillTarget.state,
    { type: 'surface', sourceId: 'masonry', ownerId: 'a' },
    250,
  )
  const promptAgain = stepCursor(
    reverseGap.state,
    { type: 'activation-target', target: { sourceId: 'masonry', ownerId: 'a', key: 'prompt-text' } },
    300,
  )
  expect(promptAgain.state).toEqual({
    type: 'active',
    lastTarget: {
      type: 'activation-target',
      target: { sourceId: 'masonry', ownerId: 'a', key: 'prompt-text' },
    },
    expiresAt: null,
    retainPill: false,
  })
})

test('cursor presentation bridges pill gaps without depending on tooltip state', () => {
  const acquired = stepCursor(coldPillCursor, pill('a', 'profile'), 100)
  const gap = stepCursor(acquired.state, { type: 'pill-gap', sourceId: 'masonry', ownerId: 'a' }, 150)
  expect(gap.presentedPill).toEqual({ sourceId: 'masonry', ownerId: 'a', key: 'profile' })
  expect(gap.nextDeadline).toBe(1150)

  const card = stepCursor(gap.state, { type: 'surface', sourceId: 'masonry', ownerId: 'a' }, 200)
  expect(card.presentedPill).toBeNull()
  expect(card.active).toBe(true)

  const laterGap = stepCursor(card.state, { type: 'pill-gap', sourceId: 'masonry', ownerId: 'a' }, 250)
  expect(laterGap.presentedPill).toBeNull()
  expect(laterGap.active).toBe(true)
})

test('reaching any pill refreshes cursor activation across owners', () => {
  const bridging: PillCursorState = {
    type: 'active',
    lastTarget: { type: 'pill', target: { sourceId: 'masonry', ownerId: 'a', key: 'ar' } },
    expiresAt: 1100,
    retainPill: false,
  }
  const next = stepCursor(bridging, pill('b', 'more', false), 500)

  expect(next.state).toEqual({
    type: 'active',
    lastTarget: { type: 'pill', target: { sourceId: 'masonry', ownerId: 'b', key: 'more' } },
    expiresAt: null,
    retainPill: true,
  })
  expect(next.presentedPill).toEqual({ sourceId: 'masonry', ownerId: 'b', key: 'more' })
})

test('cold tooltip charging resets on movement and opens after a stationary delay', () => {
  const acquired = stepTooltip(coldPillTooltip, pill('a', 'profile'), 100)
  expect(acquired.state).toEqual({
    type: 'charging',
    target: { sourceId: 'masonry', ownerId: 'a', key: 'profile' },
    startedAt: 100,
  })
  expect(acquired.previewTarget).toBeNull()

  const moved = stepTooltip(acquired.state, pill('a', 'profile'), 200, true)
  expect(moved.state).toEqual({
    type: 'charging',
    target: { sourceId: 'masonry', ownerId: 'a', key: 'profile' },
    startedAt: 200,
  })
  expect(stepTooltip(moved.state, pill('a', 'profile'), 449).previewTarget).toBeNull()

  const opened = stepTooltip(moved.state, pill('a', 'profile'), 450)
  expect(opened.state.type).toBe('warm')
  expect(opened.previewTarget).toEqual({ sourceId: 'masonry', ownerId: 'a', key: 'profile' })
})

test('tooltip gap retention expires on its own deadline', () => {
  const target = { sourceId: 'masonry', ownerId: 'a', key: 'profile' }
  const gap = stepTooltip(
    warmTooltip(target),
    { type: 'pill-gap', sourceId: 'masonry', ownerId: 'a' },
    100,
  )

  expect(gap.state).toEqual({
    type: 'warm',
    lastPreview: target,
    expiresAt: 400,
    retainPreview: true,
  })
  expect(gap.previewTarget).toEqual(target)
  expect(gap.nextDeadline).toBe(400)

  const expired = stepTooltip(gap.state, { type: 'pill-gap', sourceId: 'masonry', ownerId: 'a' }, 400)
  expect(expired.state).toEqual({ type: 'cold' })
  expect(expired.previewTarget).toBeNull()
})

test('tooltip warmth is shared across surfaces independently of the cursor bridge', () => {
  const outside = stepTooltip(
    warmTooltip({ sourceId: 'masonry', ownerId: 'a', key: 'profile' }),
    { type: 'none' },
    100,
  )
  expect(outside.previewTarget).toBeNull()
  expect(outside.state.type).toBe('warm')

  const lightboxPill = stepTooltip(outside.state, pill('cluster', 'image', true, 'lightbox'), 250, true)
  expect(lightboxPill.state.type).toBe('warm')
  expect(lightboxPill.previewTarget).toEqual({ sourceId: 'lightbox', ownerId: 'cluster', key: 'image' })
})

test('a gap only retains presentation inside the target owner', () => {
  const acquired = stepCursor(coldPillCursor, pill('card-a', 'profile'), 100)
  const otherSurfaceGap = stepCursor(
    acquired.state,
    { type: 'pill-gap', sourceId: 'lightbox', ownerId: 'cluster' },
    150,
  )
  expect(otherSurfaceGap.active).toBe(true)
  expect(otherSurfaceGap.presentedPill).toBeNull()

  const tooltipGap = stepTooltip(
    warmTooltip({ sourceId: 'masonry', ownerId: 'card-a', key: 'profile' }),
    { type: 'pill-gap', sourceId: 'lightbox', ownerId: 'cluster' },
    150,
  )
  expect(tooltipGap.state.type).toBe('warm')
  expect(tooltipGap.previewTarget).toBeNull()
})

test('a non-previewable pill closes the tooltip and a later gap cannot resurrect it', () => {
  const textPill = stepTooltip(
    warmTooltip({ sourceId: 'masonry', ownerId: 'a', key: 'profile' }),
    pill('a', 'ar', false),
    100,
  )
  expect(textPill.previewTarget).toBeNull()
  expect(textPill.charge).toBeNull()

  const gap = stepTooltip(
    textPill.state,
    { type: 'pill-gap', sourceId: 'masonry', ownerId: 'a' },
    200,
    true,
  )
  expect(gap.previewTarget).toBeNull()
})

test('prompt text never participates in tooltip activation', () => {
  const result = stepTooltip(
    coldPillTooltip,
    { type: 'activation-target', target: { sourceId: 'masonry', ownerId: 'a', key: 'prompt-text' } },
    100,
  )
  expect(result.state).toEqual({ type: 'cold' })
  expect(result.previewTarget).toBeNull()
  expect(result.charge).toBeNull()
})

test('an expired tooltip session makes a newly reached pill charge again', () => {
  const expired: PillTooltipState = {
    type: 'warm',
    lastPreview: { sourceId: 'masonry', ownerId: 'a', key: 'profile' },
    expiresAt: 400,
    retainPreview: false,
  }
  const result = stepTooltip(expired, pill('b', 'image'), 400, true)

  expect(result.state).toEqual({
    type: 'charging',
    target: { sourceId: 'masonry', ownerId: 'b', key: 'image' },
    startedAt: 400,
  })
  expect(result.previewTarget).toBeNull()
})
