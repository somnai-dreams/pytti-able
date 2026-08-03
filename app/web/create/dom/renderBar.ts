// renderBar.ts — the prompt bar + settings popover projection. The input echoes through
// renderNow (main wires that); this module only projects latest state each frame. The
// popover anchors to the bar through the shell CSS (layout data, never measured) and
// springs open/closed.
import { spring, springGoToEnd, springMostlyDone, springStep } from '@kit/midui/motion'
import type { CreateState } from '../core/model'
import type { AspectId, LookId, QualityId } from '../core/presets'

let promptEl: HTMLInputElement
let goEl: HTMLButtonElement
let popEl: HTMLElement
let sseEl: HTMLElement
let chips: { el: HTMLElement; row: 'aspect' | 'quality' | 'look'; value: string | null }[] = []
let seedRandomEl: HTMLElement
let seedLockedEl: HTMLElement

const pop = spring(0)

export function initBar(els: {
  prompt: HTMLInputElement
  go: HTMLButtonElement
  popover: HTMLElement
  sse: HTMLElement
}): void {
  promptEl = els.prompt
  goEl = els.go
  popEl = els.popover
  sseEl = els.sse
  chips = []
  for (const el of popEl.querySelectorAll<HTMLElement>('[data-aspect]')) {
    chips.push({ el, row: 'aspect', value: el.dataset['aspect'] === 'custom' ? null : el.dataset['aspect']! })
  }
  for (const el of popEl.querySelectorAll<HTMLElement>('[data-quality]')) {
    chips.push({ el, row: 'quality', value: el.dataset['quality'] === 'custom' ? null : el.dataset['quality']! })
  }
  for (const el of popEl.querySelectorAll<HTMLElement>('[data-look]')) {
    chips.push({ el, row: 'look', value: el.dataset['look'] === 'custom' ? null : el.dataset['look']! })
  }
  seedRandomEl = mustQuery('[data-seed="random"]')
  seedLockedEl = mustQuery('[data-seed="locked"]')
}

function mustQuery(selector: string): HTMLElement {
  const el = popEl.querySelector<HTMLElement>(selector)
  if (el == null) throw new Error(`missing popover element ${selector}`)
  return el
}

function rowValue(state: CreateState, row: 'aspect' | 'quality' | 'look'): AspectId | QualityId | LookId | null {
  switch (row) {
    case 'aspect':
      return state.composer.aspect
    case 'quality':
      return state.composer.quality
    case 'look':
      return state.composer.look
  }
}

export function renderBar(state: CreateState, springSteps: number): boolean {
  const ready = state.boot.phase === 'ready'
  promptEl.disabled = !ready
  goEl.disabled = !ready
  if (promptEl.value !== state.composer.prompt) promptEl.value = state.composer.prompt
  promptEl.placeholder = state.composer.tweak != null ? 'tweaking — clear to start fresh' : 'describe a scene…'
  promptEl.classList.toggle('tweaking', state.composer.tweak != null)

  sseEl.style.display = state.sse.phase === 'retrying' ? '' : 'none'

  // Popover spring: scale/opacity from the gear.
  pop.dest = state.composer.popoverOpen ? 1 : 0
  if (state.env.reducedMotion) springGoToEnd(pop)
  for (let i = 0; i < springSteps; i++) springStep(pop)
  const t = pop.pos
  const visible = state.composer.popoverOpen || t > 0.02
  popEl.style.display = visible ? '' : 'none'
  popEl.style.opacity = String(t)
  popEl.style.transform = `translateY(${(1 - t) * -6}px) scale(${0.92 + 0.08 * t})`
  popEl.style.pointerEvents = state.composer.popoverOpen ? 'auto' : 'none'

  if (visible) {
    const inTweak = state.composer.tweak != null
    for (const chip of chips) {
      const current = rowValue(state, chip.row)
      if (chip.value == null) {
        // The CUSTOM chip exists only while a tweak row inherits its base.
        chip.el.style.display = inTweak && current == null ? '' : 'none'
        chip.el.classList.toggle('sel', current == null)
      } else {
        chip.el.classList.toggle('sel', current === chip.value)
      }
    }
    const seed = state.composer.seedMode
    seedRandomEl.classList.toggle('sel', seed.kind === 'random')
    seedLockedEl.classList.toggle('sel', seed.kind === 'locked')
    seedLockedEl.textContent = seed.kind === 'locked' ? `🔒 ${seed.seed}` : '🔒 LOCK'
  }

  return !springMostlyDone(pop)
}
