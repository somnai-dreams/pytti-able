// renderBar.ts — the prompt bar + settings popover projection. The input echoes through
// renderNow (main wires that); this module only projects latest state each frame. The
// popover anchors to the bar through the shell CSS (layout data, never measured) and
// springs open/closed. §15 additions: the init chip (thumb · MASK · ✕) between the
// input and the gear, and the INIT row (strength presets + HOLD + torch note) that
// exists iff an image is attached.
import { spring, springGoToEnd, springMostlyDone, springStep } from '@kit/midui/motion'
import { uploadUrl } from '../core/api'
import { maskEditingLocked } from '../core/init'
import type { CreateState } from '../core/model'
import { STEPS_IDS } from '../core/presets'

let promptEl: HTMLInputElement
let goEl: HTMLButtonElement
let attachEl: HTMLButtonElement
let popEl: HTMLElement
let sseEl: HTMLElement
let chips: { el: HTMLElement; row: 'aspect' | 'size' | 'steps' | 'look' | 'init'; value: string | null }[] = []
let seedRandomEl: HTMLElement
let seedLockedEl: HTMLElement
let stepsCustomEl: HTMLInputElement
let initRowEl: HTMLElement
let initNoteEl: HTMLElement
let holdEl: HTMLElement
let chipEl: HTMLElement
let chipThumbEl: HTMLImageElement
let chipNameEl: HTMLElement
let chipMaskEl: HTMLButtonElement

// Thumb load state is a node-cache fact (same as gallery thumbs), never app state.
let chipSrc = ''
let chipThumbFailed = false

const pop = spring(0)

export function initBar(deps: {
  scheduleRender: () => void
  prompt: HTMLInputElement
  go: HTMLButtonElement
  attach: HTMLButtonElement
  popover: HTMLElement
  sse: HTMLElement
  chip: HTMLElement
  chipThumb: HTMLImageElement
  chipName: HTMLElement
  chipMask: HTMLButtonElement
}): void {
  promptEl = deps.prompt
  goEl = deps.go
  attachEl = deps.attach
  popEl = deps.popover
  sseEl = deps.sse
  chipEl = deps.chip
  chipThumbEl = deps.chipThumb
  chipNameEl = deps.chipName
  chipMaskEl = deps.chipMask
  chipThumbEl.addEventListener('load', () => {
    chipThumbFailed = false
    deps.scheduleRender()
  })
  chipThumbEl.addEventListener('error', () => {
    // A base init_image outside app/uploads/ 404s here (§15.8): thumbless basename chip,
    // MASK disabled — strength/hold/submit all still work.
    chipThumbFailed = true
    deps.scheduleRender()
  })
  chips = []
  for (const el of popEl.querySelectorAll<HTMLElement>('[data-aspect]')) {
    chips.push({ el, row: 'aspect', value: el.dataset['aspect'] === 'custom' ? null : el.dataset['aspect']! })
  }
  for (const el of popEl.querySelectorAll<HTMLElement>('[data-size]')) {
    chips.push({ el, row: 'size', value: el.dataset['size'] === 'custom' ? null : el.dataset['size']! })
  }
  for (const el of popEl.querySelectorAll<HTMLElement>('[data-steps]')) {
    // No CUSTOM chip in this row — the custom input is the custom path (§5.1),
    // so every dataset value feeds parseStepsId verbatim.
    chips.push({ el, row: 'steps', value: el.dataset['steps']! })
  }
  for (const el of popEl.querySelectorAll<HTMLElement>('[data-look]')) {
    chips.push({ el, row: 'look', value: el.dataset['look'] === 'custom' ? null : el.dataset['look']! })
  }
  for (const el of popEl.querySelectorAll<HTMLElement>('[data-init-strength]')) {
    chips.push({ el, row: 'init', value: el.dataset['initStrength'] === 'custom' ? null : el.dataset['initStrength']! })
  }
  seedRandomEl = mustQuery('[data-seed="random"]')
  seedLockedEl = mustQuery('[data-seed="locked"]')
  stepsCustomEl = mustQuery('#steps-custom') as HTMLInputElement
  initRowEl = mustQuery('#init-row')
  initNoteEl = mustQuery('#init-note')
  holdEl = mustQuery('[data-hold]')
}

function mustQuery(selector: string): HTMLElement {
  const el = popEl.querySelector<HTMLElement>(selector)
  if (el == null) throw new Error(`missing popover element ${selector}`)
  return el
}

function rowValue(state: CreateState, row: 'aspect' | 'size' | 'steps' | 'look' | 'init'): string | null {
  switch (row) {
    case 'aspect':
      return state.composer.aspect
    case 'size':
      return state.composer.size
    case 'steps':
      // The chips' dataset strings are the numbers verbatim — String() is the dual of
      // main's parseStepsId at the same dom boundary. steps is never null (§5.3:
      // always a concrete validated number), so this row never shows a CUSTOM chip.
      return String(state.composer.steps)
    case 'look':
      return state.composer.look
    case 'init':
      return state.composer.init == null ? null : state.composer.init.strength
  }
}

function renderChip(state: CreateState): void {
  const init = state.composer.init
  chipEl.style.display = init == null ? 'none' : ''
  if (init == null) {
    if (chipSrc !== '') {
      chipSrc = ''
      chipThumbEl.removeAttribute('src')
      chipThumbFailed = false
    }
    return
  }
  const image = init.image
  const src = image.kind === 'uploading' ? image.localUrl : (image.localUrl ?? uploadUrl(image.path))
  if (src !== chipSrc) {
    chipSrc = src
    chipThumbFailed = false
    chipThumbEl.src = src
  }
  chipThumbEl.style.display = chipThumbFailed ? 'none' : ''
  chipNameEl.style.display = chipThumbFailed ? '' : 'none'
  chipNameEl.textContent = image.name
  const tweak = state.composer.tweak
  const opaqueLocked = tweak != null && maskEditingLocked(init.strength, tweak.baseValues)
  chipMaskEl.disabled = image.kind === 'uploading' || chipThumbFailed || opaqueLocked
  chipMaskEl.textContent = init.mask != null ? 'MASK ✓' : 'MASK'
  chipMaskEl.title = opaqueLocked
    ? 'bench-authored weight — attach a new image to repaint'
    : 'paint where the image should hold'
}

export function renderBar(state: CreateState, springSteps: number): boolean {
  const ready = state.boot.phase === 'ready'
  promptEl.disabled = !ready
  goEl.disabled = !ready
  attachEl.disabled = !ready
  if (promptEl.value !== state.composer.prompt) promptEl.value = state.composer.prompt
  promptEl.placeholder = state.composer.tweak != null ? 'tweaking — clear to start fresh' : 'describe a scene…'
  promptEl.classList.toggle('tweaking', state.composer.tweak != null)

  renderChip(state)

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
    const init = state.composer.init
    initRowEl.style.display = init == null ? 'none' : '' // the row exists iff attached (§15.5)
    initNoteEl.style.display = init != null && init.holdMeaning ? '' : 'none'
    holdEl.classList.toggle('sel', init != null && init.holdMeaning)
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
    // The steps CUSTOM input: a preset value lives on its chip (input empty); any other
    // value shows as the number itself, highlighted like a selected chip. Never rewrite
    // while focused — main's input listener owns the text mid-edit (invalid text keeps
    // the last valid composer.steps); this projection re-syncs on blur/close.
    if (document.activeElement !== stepsCustomEl) {
      const text = STEPS_IDS.includes(state.composer.steps) ? '' : String(state.composer.steps)
      if (stepsCustomEl.value !== text) stepsCustomEl.value = text
      stepsCustomEl.classList.remove('invalid')
    }
    stepsCustomEl.classList.toggle('sel', !STEPS_IDS.includes(state.composer.steps))
    const seed = state.composer.seedMode
    seedRandomEl.classList.toggle('sel', seed.kind === 'random')
    seedLockedEl.classList.toggle('sel', seed.kind === 'locked')
    seedLockedEl.textContent = seed.kind === 'locked' ? `🔒 ${seed.seed}` : '🔒 LOCK'
  }

  return !springMostlyDone(pop)
}
