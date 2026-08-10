// renderBar.ts — the prompt bar + settings popover projection. The input echoes through
// renderNow (main wires that); this module only projects latest state each frame. The
// popover anchors to the bar through the shell CSS (layout data, never measured) and
// springs open/closed. §15 additions: the init chip (thumb · MASK · ✕) between the
// input and the gear, and the INIT row (strength presets + HOLD + torch note) that
// exists iff an image is attached. §5.1a: the ASPECT row's AUTO chip is disabled
// (MASK-chip surface treatment) until the attachment's natural dims are known.
// §5.7/§16: the collapsed EXPERIMENTS disclosure at the bottom (chevron button +
// ten chip rows); rows the engine's guards refuse are disabled (AUTO-chip
// treatment): PYRAMID while HOLD MEANING is on or an underpaint is effective,
// NOISE and ANNEAL while LOOK is VQGAN or FOURIER is on, ANNEAL while AUTO-STOP or
// PROJECTION is on, UNDERPAINT while LOOK is VQGAN (v1 scope), PROJECTION under
// VQGAN / AUTO-STOP / non-/8 dims, FOURIER anywhere but LOOK UNLIMITED.
import { spring, springGoToEnd, springMostlyDone, springStep } from '@kit/midui/motion'
import { uploadUrl } from '../core/api'
import { initNaturalDims, maskEditingLocked } from '../core/init'
import type { CreateState } from '../core/model'
import { projectionDimsSafe, STEPS_IDS } from '../core/presets'

type ChipRow =
  | 'aspect'
  | 'size'
  | 'steps'
  | 'look'
  | 'init'
  | 'noise'
  | 'pyramid'
  | 'anneal'
  | 'coherence'
  | 'fullvision'
  | 'phase'
  | 'autostop'
  | 'underpaint'
  | 'projection'
  | 'fourier'

let promptEl: HTMLInputElement
let goEl: HTMLButtonElement
let attachEl: HTMLButtonElement
let popEl: HTMLElement
let sseEl: HTMLElement
let chips: { el: HTMLElement; row: ChipRow; value: string | null }[] = []
let aspectAutoEl: HTMLButtonElement
let expToggleEl: HTMLButtonElement
let expBodyEl: HTMLElement
// Guarded rows (§5.7): chips that disable while an engine-refused pairing would
// otherwise be reachable. defaultTitle is the markup's own hint (e.g. PINK's battery
// note), restored whenever the chip re-enables — the guard reason must not eat it.
type GuardedChip = { el: HTMLButtonElement; defaultTitle: string }
let pyramidChipEls: GuardedChip[] = []
let noiseChipEls: GuardedChip[] = []
let annealChipEls: GuardedChip[] = []
let underpaintChipEls: GuardedChip[] = []
let projectionChipEls: GuardedChip[] = []
let fourierChipEls: GuardedChip[] = []
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
  // The EXPERIMENTS rows (§5.7) — same registry, same CUSTOM convention.
  const expRows: [ChipRow, string][] = [
    ['noise', 'noise'],
    ['pyramid', 'pyramid'],
    ['anneal', 'anneal'],
    ['coherence', 'coherence'],
    ['fullvision', 'fullvision'],
    ['phase', 'phase'],
    ['autostop', 'autostop'],
    ['underpaint', 'underpaint'],
    ['projection', 'projection'],
    ['fourier', 'fourier'],
  ]
  for (const [row, key] of expRows) {
    for (const el of popEl.querySelectorAll<HTMLElement>(`[data-${key}]`)) {
      chips.push({ el, row, value: el.dataset[key] === 'custom' ? null : el.dataset[key]! })
    }
  }
  const guarded = (selector: string): GuardedChip[] =>
    [...popEl.querySelectorAll<HTMLButtonElement>(selector)].map((el) => ({ el, defaultTitle: el.title }))
  pyramidChipEls = guarded('button[data-pyramid]')
  noiseChipEls = guarded('button[data-noise]')
  annealChipEls = guarded('button[data-anneal]')
  underpaintChipEls = guarded('button[data-underpaint]')
  projectionChipEls = guarded('button[data-projection]')
  fourierChipEls = guarded('button[data-fourier]')
  aspectAutoEl = mustQuery('[data-aspect="auto"]') as HTMLButtonElement
  expToggleEl = mustQuery('#exp-toggle') as HTMLButtonElement
  expBodyEl = mustQuery('#exp-body')
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

function rowValue(state: CreateState, row: ChipRow): string | null {
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
    // EXPERIMENTS rows (§5.7) — the ids ARE the dataset strings; null = CUSTOM.
    case 'noise':
      return state.composer.experiments.noise
    case 'pyramid':
      return state.composer.experiments.pyramid
    case 'anneal':
      return state.composer.experiments.anneal
    case 'coherence':
      return state.composer.experiments.coherence
    case 'fullvision':
      return state.composer.experiments.fullVision
    case 'phase':
      return state.composer.experiments.phase
    case 'autostop':
      return state.composer.experiments.autoStop
    case 'underpaint':
      return state.composer.experiments.underpaint
    case 'projection':
      return state.composer.experiments.projection
    case 'fourier':
      return state.composer.experiments.fourier
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
    const tweak = state.composer.tweak
    const inTweak = tweak != null
    const init = state.composer.init
    initRowEl.style.display = init == null ? 'none' : '' // the row exists iff attached (§15.5)
    initNoteEl.style.display = init != null && init.holdMeaning ? '' : 'none'
    holdEl.classList.toggle('sel', init != null && init.holdMeaning)
    // The EXPERIMENTS disclosure (§5.7): collapsed by default, projected from
    // composer state (never part of the submission payload).
    const expOpen = state.composer.experimentsOpen
    expToggleEl.classList.toggle('open', expOpen)
    expToggleEl.setAttribute('aria-expanded', expOpen ? 'true' : 'false')
    expBodyEl.style.display = expOpen ? '' : 'none'
    // §5.7 pyramid × HOLD MEANING: the engine refuses c2f + semantic init, so while
    // HOLD is on the row shows OFF (applyHoldMeaning forced it) and disables — the
    // AUTO-chip locked-surface treatment (disabled + title). §16 adds the second
    // dominance: an EFFECTIVE underpaint (concrete row, or tweak CUSTOM replaying a
    // base envelope) also holds the row at OFF — the finish must run flat.
    const holdOn = init != null && init.holdMeaning
    const experiments = state.composer.experiments
    const underpaintActive =
      experiments.underpaint == null
        ? tweak != null && tweak.baseUnderpaint != null
        : experiments.underpaint !== 'off'
    for (const chip of pyramidChipEls) {
      chip.el.disabled = holdOn || underpaintActive
      chip.el.title = holdOn
        ? 'HOLD MEANING is on — the engine refuses pyramid + semantic init'
        : underpaintActive
          ? 'UNDERPAINT is on — the finish must not run the pyramid (stage 1 would downsample the underpaint away)'
          : chip.defaultTitle
    }
    // §5.7 LOOK VQGAN × noise/anneal: a codebook init has no spectrum to shape and
    // annealing rejects latent models, so while the look is VQGAN the NOISE row shows
    // WHITE and the ANNEAL row OFF (applyLook forced them) and both disable. The
    // ANNEAL row also disables while AUTO-STOP is on (applyAutoStop forced it OFF —
    // the engine refuses annealing + auto_stop). §16 adds: NOISE and ANNEAL disable
    // while FOURIER is on (the fourier scope pins white spectrum, no annealing);
    // ANNEAL disables while PROJECTION is on (one between-steps intervention at a
    // time). Same treatment as pyramid × HOLD.
    const vqganLook = state.composer.look === 'vqgan'
    const autoStopOn = experiments.autoStop === 'on'
    const projectionOn = experiments.projection === 'on'
    const fourierOn = experiments.fourier === 'on'
    for (const chip of noiseChipEls) {
      chip.el.disabled = vqganLook || fourierOn
      chip.el.title = vqganLook
        ? 'LOOK is VQGAN — a codebook init has no spectrum to shape'
        : fourierOn
          ? 'FOURIER is on — the Fourier init is 1/f-shaped already (white only)'
          : chip.defaultTitle
    }
    for (const chip of annealChipEls) {
      chip.el.disabled = vqganLook || autoStopOn || projectionOn || fourierOn
      chip.el.title = vqganLook
        ? 'LOOK is VQGAN — annealing rejects latent models'
        : autoStopOn
          ? 'AUTO-STOP is on — the engine refuses annealing + auto-stop'
          : projectionOn
            ? 'PROJECTION is on — one between-steps intervention at a time'
            : fourierOn
              ? 'FOURIER is on — annealing does not compose with a spectrum parameterization'
              : chip.defaultTitle
    }
    // §16 UNDERPAINT: disabled under LOOK VQGAN (v1 scope — a latent finish over an
    // underpaint init is unevaluated).
    for (const chip of underpaintChipEls) {
      chip.el.disabled = vqganLook
      chip.el.title = vqganLook ? 'LOOK is VQGAN — underpaint finishes are pixel-canvas only (v1)' : chip.defaultTitle
    }
    // §16 PROJECTION: the engine refuses manifold_projection on latent canvases and
    // alongside auto_stop; the ds8 tokenizer stride needs /8 dims (the one table
    // offender is DRAFT 16:9's 320x180).
    const dimsSafe = projectionDimsSafe(state.composer.aspect, state.composer.size, tweak == null ? null : tweak.baseValues)
    for (const chip of projectionChipEls) {
      chip.el.disabled = vqganLook || autoStopOn || !dimsSafe
      chip.el.title = vqganLook
        ? 'LOOK is VQGAN — projection has no meaning on a latent canvas'
        : autoStopOn
          ? 'AUTO-STOP is on — scheduled image edits break plateau semantics'
          : !dimsSafe
            ? 'canvas dims must be multiples of 8 — pick another aspect/size'
            : chip.defaultTitle
    }
    // §16 FOURIER: enabled ONLY while LOOK is UNLIMITED (the engine scopes
    // fourier_parameterization to the Unlimited Palette; a CUSTOM look is not
    // provably unlimited — disabled there too, the exact-match doctrine).
    const unlimitedLook = state.composer.look === 'unlimited'
    for (const chip of fourierChipEls) {
      chip.el.disabled = !unlimitedLook
      chip.el.title = unlimitedLook ? chip.defaultTitle : 'LOOK must be UNLIMITED — fourier re-parameterizes the Unlimited Palette canvas'
    }
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
    // AUTO is selectable only while the attachment's own dims are known (§5.1a) —
    // same surface treatment as the MASK chip's locked states (disabled + title).
    const autoReady = initNaturalDims(init) != null
    aspectAutoEl.disabled = !autoReady
    aspectAutoEl.title = autoReady
      ? 'size the canvas to the image’s aspect ratio'
      : 'attach an image to size the canvas from it'
    const seed = state.composer.seedMode
    seedRandomEl.classList.toggle('sel', seed.kind === 'random')
    seedLockedEl.classList.toggle('sel', seed.kind === 'locked')
    seedLockedEl.textContent = seed.kind === 'locked' ? `🔒 ${seed.seed}` : '🔒 LOCK'
  }

  return !springMostlyDone(pop)
}
