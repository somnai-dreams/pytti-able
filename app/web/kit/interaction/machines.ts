// @cs
// interaction/machines: the pill-interaction state machines — pure tagged unions advanced
// by (pointer region, timestamp). Extracted verbatim from pillInteractionState.ts; zero
// domain coupling (targets are opaque {sourceId, ownerId, key} strings).
//
// types:
//   PillInteractionOwner  = { sourceId, ownerId }; PillInteractionTarget adds { key }
//   PillPointerRegion = {type:'none'} | {type:'surface'}&Owner | {type:'activation-target',
//                       target} | {type:'pill', target, previewable} | {type:'pill-gap'}&Owner
//   PillCursorState   = cold | active { lastTarget, expiresAt, retainPill }
//   PillTooltipState  = cold | charging { target, startedAt } | warm { lastPreview,
//                       expiresAt, retainPreview }
//
// functions:
//   advancePillCursor(prev, region, now, bridgeMs) -> { state, presentedPill, active,
//     nextDeadline }   — the eyedropper bridge after leaving a target + gap handoff
//   advancePillTooltip(prev, region, now, pointerMoved, activationDwellMs, warmGraceMs)
//     -> { state, previewTarget, charge, nextDeadline }   — dwell/warm/grace machine
//   pillPreviewChargeProgress(now, startedAt, durationMs) -> [0,1], proven
//   samePillInteractionTarget(a, b); pillPointerRegionOwner(region)
//   coldPillCursor / coldPillTooltip — the rest states
//
// The controller loop pattern: poll a region each rAF, advance both machines, schedule a
// wake-up timer at min(nextDeadline) — deadlines make the timing explicit data, not
// setTimeout choreography.
//
// freerange: 4/8 (2 partial) — the deadline arithmetic is analyzed at 0 findings; the
// union-typed transition functions are object domain, checked by the test suite.
// @/cs

export type PillInteractionOwner = { sourceId: string; ownerId: string }
export type PillInteractionTarget = PillInteractionOwner & { key: string }

export type PillPointerRegion =
  | { type: 'none' }
  | ({ type: 'surface' } & PillInteractionOwner)
  | { type: 'activation-target'; target: PillInteractionTarget }
  | { type: 'pill'; target: PillInteractionTarget; previewable: boolean }
  | ({ type: 'pill-gap' } & PillInteractionOwner)

export type PillCursorTarget =
  | { type: 'activation-target'; target: PillInteractionTarget }
  | { type: 'pill'; target: PillInteractionTarget }

export type PillCursorState =
  | { type: 'cold' }
  | {
      type: 'active'
      lastTarget: PillCursorTarget
      expiresAt: number | null
      retainPill: boolean
    }

export type PillCursorResult = {
  state: PillCursorState
  presentedPill: PillInteractionTarget | null
  active: boolean
  nextDeadline: number | null
}

export type PillTooltipState =
  | { type: 'cold' }
  | { type: 'charging'; target: PillInteractionTarget; startedAt: number }
  | {
      type: 'warm'
      lastPreview: PillInteractionTarget
      expiresAt: number | null
      retainPreview: boolean
    }

export type PillTooltipResult = {
  state: PillTooltipState
  previewTarget: PillInteractionTarget | null
  charge: { target: PillInteractionTarget; startedAt: number; durationMs: number } | null
  nextDeadline: number | null
}

export const coldPillCursor: PillCursorState = { type: 'cold' }
export const coldPillTooltip: PillTooltipState = { type: 'cold' }

export function samePillInteractionTarget(
  a: PillInteractionTarget | null,
  b: PillInteractionTarget | null,
): boolean {
  if (a == null || b == null) return a === b
  return a.sourceId === b.sourceId && a.ownerId === b.ownerId && a.key === b.key
}

export function pillPointerRegionOwner(region: PillPointerRegion): PillInteractionOwner | null {
  switch (region.type) {
    case 'none':
      return null
    case 'surface':
    case 'pill-gap':
      return { sourceId: region.sourceId, ownerId: region.ownerId }
    case 'activation-target':
    case 'pill':
      return { sourceId: region.target.sourceId, ownerId: region.target.ownerId }
  }
}

function cursorTarget(region: PillPointerRegion): PillCursorTarget | null {
  switch (region.type) {
    case 'activation-target':
      return { type: 'activation-target', target: region.target }
    case 'pill':
      return { type: 'pill', target: region.target }
    case 'none':
    case 'surface':
    case 'pill-gap':
      return null
  }
}

function currentPreviewTarget(region: PillPointerRegion): PillInteractionTarget | null {
  if (region.type !== 'pill' || !region.previewable) return null
  return region.target
}

function isGapForTarget(region: PillPointerRegion, target: PillInteractionTarget): boolean {
  return (
    region.type === 'pill-gap' && region.sourceId === target.sourceId && region.ownerId === target.ownerId
  )
}

// Prompt text and every pill participate, whether or not a pill has a tooltip. This state owns
// only the eyedropper bridge after leaving a target and the visual handoff across a packing gap.
export function advancePillCursor(
  previous: PillCursorState,
  region: PillPointerRegion,
  now: number,
  bridgeMs: number,
): PillCursorResult {
  const bridge = Math.max(1, bridgeMs)
  const target = cursorTarget(region)
  if (target != null) {
    const pill = target.type === 'pill' ? target.target : null
    return {
      state: { type: 'active', lastTarget: target, expiresAt: null, retainPill: pill != null },
      presentedPill: pill,
      active: true,
      nextDeadline: null,
    }
  }

  switch (previous.type) {
    case 'cold':
      return { state: coldPillCursor, presentedPill: null, active: false, nextDeadline: null }
    case 'active': {
      const expiresAt = previous.expiresAt ?? now + bridge
      if (now >= expiresAt) {
        return { state: coldPillCursor, presentedPill: null, active: false, nextDeadline: null }
      }
      const lastPill = previous.lastTarget.type === 'pill' ? previous.lastTarget.target : null
      const retainPill = lastPill != null && previous.retainPill && isGapForTarget(region, lastPill)
      return {
        state: { type: 'active', lastTarget: previous.lastTarget, expiresAt, retainPill },
        presentedPill: retainPill ? lastPill : null,
        active: true,
        nextDeadline: expiresAt,
      }
    }
  }
}

// Only previewable pills participate. Activation dwell, gap retention, and instant reuse after a
// tooltip has opened are app-global and have no dependency on the cursor state above.
export function advancePillTooltip(
  previous: PillTooltipState,
  region: PillPointerRegion,
  now: number,
  pointerMoved: boolean,
  activationDwellMs: number,
  warmGraceMs: number,
): PillTooltipResult {
  const activationDwell = Math.max(1, activationDwellMs)
  const warmGrace = Math.max(1, warmGraceMs)
  const previousTooltip =
    previous.type === 'warm' && previous.expiresAt != null && now >= previous.expiresAt
      ? coldPillTooltip
      : previous
  const currentPreview = currentPreviewTarget(region)

  let state: PillTooltipState = coldPillTooltip
  if (currentPreview != null) {
    switch (previousTooltip.type) {
      case 'cold':
        state = { type: 'charging', target: currentPreview, startedAt: now }
        break
      case 'charging': {
        const sameTarget = samePillInteractionTarget(previousTooltip.target, currentPreview)
        if (!sameTarget || pointerMoved) {
          state = { type: 'charging', target: currentPreview, startedAt: now }
          break
        }
        const opensAt = previousTooltip.startedAt + activationDwell
        state =
          now >= opensAt
            ? { type: 'warm', lastPreview: currentPreview, expiresAt: null, retainPreview: true }
            : previousTooltip
        break
      }
      case 'warm':
        state = { type: 'warm', lastPreview: currentPreview, expiresAt: null, retainPreview: true }
        break
    }
  } else {
    switch (previousTooltip.type) {
      case 'cold':
      case 'charging':
        state = coldPillTooltip
        break
      case 'warm': {
        const retainPreview = previousTooltip.retainPreview && isGapForTarget(region, previousTooltip.lastPreview)
        state = {
          type: 'warm',
          lastPreview: previousTooltip.lastPreview,
          expiresAt: previousTooltip.expiresAt ?? now + warmGrace,
          retainPreview,
        }
        break
      }
    }
  }

  const previewTarget =
    state.type === 'warm' && currentPreview != null
      ? currentPreview
      : state.type === 'warm' && state.retainPreview && isGapForTarget(region, state.lastPreview)
        ? state.lastPreview
        : null
  const charge =
    state.type === 'charging'
      ? { target: state.target, startedAt: state.startedAt, durationMs: activationDwell }
      : null
  const nextDeadline =
    state.type === 'charging' ? state.startedAt + activationDwell : state.type === 'warm' ? state.expiresAt : null

  return { state, previewTarget, charge, nextDeadline }
}

export function pillPreviewChargeProgress(now: number, startedAt: number, durationMs: number): number {
  const duration = Math.max(1, durationMs)
  const elapsed = Math.max(0, now - startedAt)
  const progress = Math.min(1, elapsed / duration)
  console.assert(progress >= 0)
  console.assert(progress <= 1)
  return progress
}
