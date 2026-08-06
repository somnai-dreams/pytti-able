// @cs
// create/core/presets: THE preset tables (aspect / size / steps / look / seed) and the two
// maps across them — composeSubmission (composer -> the self-contained POST /api/sessions
// payload; the server composes it over the versioned tuned defaults, spec §5.6) and
// matchPresets (config snapshot -> preset ids, exact-match only). Also
// submittableValues, the schema-whitelist filter that keeps a snapshot key the server's
// coercion would 400 on from ever leaving the client. Create never touches /api/draft —
// the shared draft is the advanced bench's private working state.
//
// SIZE and STEPS are independent controls (2026-08-06, decoupled from the retired
// QUALITY preset that bundled them): size picks the dims class, steps is
// steps_per_scene VERBATIM — the chips show the raw numbers ("its the biggest
// lever" — the lead; the detail-recovery battery made steps the dominant lever).
// STEPS is a plain validated number (2026-08-05, "way more than 600 steps" + custom):
// the chips (150..2400) are shortcuts that set it; the gear's custom input takes any
// integer 1..MAX_CUSTOM_STEPS. There is NO null-inherit for steps — a tweak base's
// steps_per_scene rematerializes concretely (rematerializeSteps) and the number the
// user sees is the number that submits (§5.6).
//
// String/JSON domain — outside freerange's numeric subset; presets.test.ts is the
// checked surface.
//
// types:
//   AspectId = '1:1'|'3:4'|'4:3'|'16:9'    SizeId = 'draft'|'full'  (256- / 512-class)
//   ComposerAspect = AspectId | 'auto'     'auto' = size the canvas to the attachment's
//     own aspect ratio (§5.1a); selectable only while the attachment's natural dims are
//     known — the AspectId tables stay closed (they key the dims Records)
//   LookId = 'limited'|'unlimited'|'vqgan'
//   SeedMode = {kind:'random'} | {kind:'locked', seed}
//   ComposerSubmitInput = { prompt, aspect: ComposerAspect|null, size|null, steps: number,
//     look|null, seedMode, tweak|null, init: InitSubmitInput|null }   (null preset ids =
//     "inherit tweak base", reachable only while tweak != null; steps is never null —
//     §5.3; init per §15.6 — main maps the attachment through core/init
//     toInitSubmitInput, which enforces image-is-ready)
//   SubmissionPayload = { values, forkOf, seedLocked }   — POST /api/sessions body fields
//
// constants:
//   VISIBLE_CONTROL_FIELDS / PIN_FIELDS — the isolation invariant's two halves (§5.6):
//     every key a FRESH composeSubmission emits is a visible control or a documented pin,
//     so the payload is exactly reconstructible from what the user can see. A tweak
//     payload adds only the fork base's own snapshot keys (shown via TWEAK provenance).
//     Enforced by presets.test.ts over the full composer-option product.
//
// functions:
//   resolveDims(aspect, size) -> {width, height}        pure table lookup
//   autoDims(natural, sizeClass, multiple) -> {width, height}   the AUTO aspect's dims
//     (§5.1a): the attachment's AR fitted into the class's pixel-area budget (class² —
//     the §5.1 tables are roughly equal-area), each dim rounded to the engine-safe
//     multiple and floored at one multiple (no artificial AR clamp)
//   parseStepsId(raw) -> number                         the STEPS chips' dataset boundary:
//     exact match against STEPS_IDS, throws on unknown markup (never a nearest number)
//   parseCustomSteps(raw) -> number | null              the gear's custom-input boundary:
//     integer 1..MAX_CUSTOM_STEPS or null (user input is expected-recoverable — data,
//     not a throw; the dom layer surfaces null as the input's invalid state)
//   rematerializeSteps(baseValues) -> number            tweak rematerialization (§5.3):
//     the base's steps_per_scene verbatim when a positive integer, else DEFAULT_STEPS —
//     always concrete, no null-inherit; what the gear shows is what submits
//   lookModel(look) -> image_model string
//   composeSubmission(composer) -> SubmissionPayload    throws on empty prompt, a fresh
//     composer with null ids, or a non-positive-integer steps (caller-contract
//     violations — the three steps boundaries above guarantee validity). AUTO aspect
//     resolves through autoDims — throws without attachment natural dims (the popover
//     only enables the chip once they are known; main's submit guard covers the gap).
//     The rounding multiple comes from the LOOK (verified against pytti-core, §5.1a):
//     Limited/Unlimited Palette tensors are exactly height x width -> 8 (mp4 encode
//     needs even dims; 8 matches the c2f ladder's own granularity); VQGAN floors each
//     dim to its latent stride f = 2^(num_resolutions-1) = 16 for every model Create
//     reaches (vqgan.py line 184-192) -> 16 keeps declared dims == rendered dims. A
//     tweak CUSTOM look reads the base's image_model; non-pixel/unknown models take 16.
//     Tweak rules: steps_per_scene always carries composer.steps (rematerialized from
//     the base, so an untouched tweak still submits the base's count verbatim); width/height
//     override only when aspect != null; their size class comes from size when non-null,
//     else from exact-matching the BASE dims against the 256 table (miss -> 512 class).
//     Init rule (§15.6): fresh emits init_image + formatInitWeight (+ semantic '4' and
//     perceptor_backend torch iff holdMeaning); no attachment -> keys ABSENT, never ''.
//     Tweak overrides only on diff (an untouched simple/opaque base weight rides
//     verbatim, preserving bench cutoffs); chip removal deletes the three init keys
//     (perceptor_backend untouched); holdMeaning pins torch unconditionally when on.
//   composerDims(composer) -> {width, height}          the dims the submission renders at
//     (optimistic tile sizing); same dims rule as composeSubmission, base-dims fallback 512x512
//   matchPresets(values) -> {aspect|null, size|null, look|null}   exact-match only, no
//     nearest-neighbor guessing; dims match one class table -> aspect + size together
//     (miss -> both null). NEVER returns 'auto': the base's attachment dims are not in
//     the snapshot (they load async, §15.8), so "these dims came from AUTO" is not
//     cleanly decidable at rematerialization time — per §5.3 doctrine the miss
//     rematerializes CUSTOM, which inherits the base dims verbatim. Steps is NOT
//     preset-matched anymore — it rematerializes as a plain number via
//     rematerializeSteps; chip highlighting is a render-time comparison, not composer state
//   submittableValues(config, schemaFields) -> Record       whitelist filter
// @/cs
import {
  formatInitWeight,
  type InitSubmitInput,
  type NaturalDims,
  parseInitWeight,
  sameMask,
  semanticOn,
  strengthWeight,
} from './init'

export type AspectId = '1:1' | '3:4' | '4:3' | '16:9'
// The composer's aspect value: a table id, or AUTO — size the canvas to the
// attachment's own aspect ratio (§5.1a). Kept apart from AspectId so the dims
// Records stay exhaustively keyed by the table ids alone.
export type ComposerAspect = AspectId | 'auto'
export type SizeId = 'draft' | 'full'
export type LookId = 'limited' | 'unlimited' | 'vqgan'
export type SeedMode = { kind: 'random' } | { kind: 'locked'; seed: number }

export const ASPECT_IDS: readonly AspectId[] = ['1:1', '3:4', '4:3', '16:9']
export const SIZE_IDS: readonly SizeId[] = ['draft', 'full']
// steps_per_scene VERBATIM — the gear shows these numbers, no euphemism labels
// ("its the biggest lever" — Max; spec §5.1). Preset SHORTCUTS, not a closed set:
// composer.steps is any validated positive integer; these highlight when it matches.
export const STEPS_IDS: readonly number[] = [150, 200, 300, 600, 1200, 2400]
// The fresh composer's steps default (§5.1: the retired 'standard' pair, full + 200) —
// also the rematerialization fallback for a base without a usable steps_per_scene.
export const DEFAULT_STEPS = 200
// Custom-input ceiling (spec §5.1): typed values above this are rejected at the input
// boundary. A tweak BASE beyond it still rematerializes verbatim — the cap governs
// what the input accepts, not what a bench-authored snapshot may carry.
export const MAX_CUSTOM_STEPS = 20000
export const LOOK_IDS: readonly LookId[] = ['limited', 'unlimited', 'vqgan']

type SizeClass = 256 | 512

// aspect -> [width, height] per size class. Size picks the class; aspect the shape.
const DIMS_256: Record<AspectId, readonly [number, number]> = {
  '1:1': [256, 256],
  '3:4': [224, 288],
  '4:3': [288, 224],
  '16:9': [320, 180],
}
const DIMS_512: Record<AspectId, readonly [number, number]> = {
  '1:1': [512, 512],
  '3:4': [448, 576],
  '4:3': [576, 448],
  '16:9': [640, 360],
}

const SIZE_CLASS: Record<SizeId, SizeClass> = { draft: 256, full: 512 }

const LOOK: Record<LookId, string> = {
  limited: 'Limited Palette',
  unlimited: 'Unlimited Palette',
  vqgan: 'VQGAN',
}

// Popover display labels.
export const LOOK_LABELS: Record<LookId, string> = { limited: 'LIMITED', unlimited: 'UNLIMITED', vqgan: 'VQGAN' }

function dimsTable(sizeClass: SizeClass): Record<AspectId, readonly [number, number]> {
  return sizeClass === 256 ? DIMS_256 : DIMS_512
}

export function resolveDims(aspect: AspectId, size: SizeId): { width: number; height: number } {
  const entry = dimsTable(SIZE_CLASS[size])[aspect]
  return { width: entry[0], height: entry[1] }
}

// The engine-safe rounding multiple for AUTO dims, per image model (verified against
// pytti-core, §5.1a): PixelImage/RGBImage parameter tensors are exactly height x width —
// any dims render, so 8 is chosen for the DOWNLOAD path (libx264/yuv420p needs even
// dims; no scale filter in the encode command) and to match stage_dims' own non-final
// rounding. VQGAN floors each dim to its latent stride f = 2^(num_resolutions-1) = 16
// for every model Create reaches (default sflickr; all taming ckpts are f16) — emitting
// multiples of 16 keeps declared dims == rendered dims. Everything else (LlamaGen
// ds16/ds8, unknown bench models) takes 16: every stride in the engine divides it.
function autoDimsMultiple(model: string): 8 | 16 {
  return model === 'Limited Palette' || model === 'Unlimited Palette' ? 8 : 16
}

// §5.1a: fit the attachment's own AR into the size class's pixel-area budget (class² —
// the §5.1 tables are roughly equal-area), preserving AR, each dim rounded to the
// engine-safe multiple. No artificial AR clamp; the floor is one multiple per dim (the
// smallest the engine renders: one VQGAN latent token / one rounded pixel row).
export function autoDims(natural: NaturalDims, sizeClass: 256 | 512, multiple: 8 | 16): { width: number; height: number } {
  if (natural.width < 1 || natural.height < 1) {
    throw new Error(`autoDims: natural dims must be positive, got ${natural.width}x${natural.height}`)
  }
  const budget = sizeClass * sizeClass
  const idealWidth = Math.sqrt((budget * natural.width) / natural.height)
  const idealHeight = budget / idealWidth
  return {
    width: Math.max(multiple, Math.round(idealWidth / multiple) * multiple),
    height: Math.max(multiple, Math.round(idealHeight / multiple) * multiple),
  }
}

// The AUTO branch shared by composeSubmission and composerDims: throws without known
// attachment dims — the popover only enables the chip once they are known (§5.1a) and
// main's submit guard covers the async gap, so reaching here without them is a bug.
function autoAspectDims(composer: ComposerSubmitInput, sizeClass: 256 | 512): { width: number; height: number } {
  const init = composer.init
  if (init == null || init.natural == null) {
    throw new Error('autoDims: AUTO aspect without attachment dims (caller must guard, §5.1a)')
  }
  let model: string
  if (composer.look != null) {
    model = LOOK[composer.look]
  } else if (composer.tweak != null) {
    model = String(composer.tweak.baseValues['image_model'] ?? '') // '' -> 16, safe everywhere
  } else {
    throw new Error('autoDims: fresh composer without a concrete look (caller contract)')
  }
  return autoDims(init.natural, sizeClass, autoDimsMultiple(model))
}

// The STEPS chips' dataset strings enter core through this exact match — unknown
// markup throws (fail loud, §5.3 doctrine: never a nearest number).
export function parseStepsId(raw: string): number {
  const n = Number(raw)
  for (const steps of STEPS_IDS) {
    if (steps === n) return steps
  }
  throw new Error(`parseStepsId: unknown steps preset "${raw}"`)
}

// The gear's custom steps input boundary. User input is a provably shaky boundary —
// invalid text is expected-recoverable DATA (null), never a throw: the dom layer keeps
// the last valid number and surfaces null as the input's invalid state. Accepts only
// a plain positive decimal integer, 1..MAX_CUSTOM_STEPS.
export function parseCustomSteps(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  if (n < 1 || n > MAX_CUSTOM_STEPS) return null
  return n
}

// Tweak rematerialization (§5.3): steps has no null-inherit — the base's count is shown
// concretely (chip highlight when it matches a preset, the custom input otherwise) and
// submits verbatim. A base without a usable steps_per_scene (legacy imports with no
// snapshot, malformed values) falls to DEFAULT_STEPS — shown concretely too, so what
// the gear displays is exactly what the payload carries (§5.6). NOT capped at
// MAX_CUSTOM_STEPS: a bench-authored 50000 rematerializes as 50000.
export function rematerializeSteps(baseValues: Record<string, unknown>): number {
  const raw = baseValues['steps_per_scene']
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw
  return DEFAULT_STEPS
}

export function lookModel(look: LookId): string {
  return LOOK[look]
}

export type ComposerSubmitInput = {
  prompt: string
  aspect: ComposerAspect | null
  size: SizeId | null
  steps: number // always concrete — validated positive integer (§5.3, no null-inherit)
  look: LookId | null
  seedMode: SeedMode
  tweak: { of: string; baseValues: Record<string, unknown> } | null
  init: InitSubmitInput | null
}

export type SubmissionPayload = {
  values: Record<string, unknown>
  forkOf: string | null
  seedLocked: boolean
}

// ── The isolation invariant (spec §5.6, binding) ─────────────────────────────
// "There can be no hidden sticky state or anything like that for features I
//  can't see on the UI. It needs to be completely separate from the advanced
//  mode." — the lead, verbatim.
// Every key a fresh submission carries is either a control the user can see on
// the Create surface, or one of the four documented pins below. presets.test.ts
// asserts this over the full composer-option product; a new composeSubmission key
// fails that test until it is added here (and thereby documented).

// Field -> the visible control that determines it.
export const VISIBLE_CONTROL_FIELDS: readonly string[] = [
  'scenes', // the prompt bar
  'width', // ASPECT x SIZE chips (dims table §5.1; AUTO fits the visible attachment's AR, §5.1a)
  'height', // ASPECT x SIZE chips
  'steps_per_scene', // STEPS chips — the raw numbers, steps_per_scene verbatim
  'image_model', // LOOK chips
  'seed', // SEED toggle — the locked value is displayed next to it
  'init_image', // the attachment chip (thumb + name)
  'direct_init_weight', // INIT strength chips + the chip's MASK state
  'semantic_init_weight', // the HOLD toggle
  'perceptor_backend', // the 'torch engine' note shown while HOLD is on
]

// Fixed pins: constant on every fresh submission (never user-varied, but stated
// here and in spec §5.6's pin table — visible as documentation, not as a control).
export const PIN_FIELDS: readonly string[] = [
  'animation_mode', // 'off' — Create is a stills surface by construction
  'interpolation_steps', // 0 — no scene-0 prompt ramp
  'coarse_to_fine', // true — the judged pyramid pin (omitted iff HOLD MEANING)
  'coarse_stages', // 3 — thumbnail -> half -> full
]

// Exact-match a (width, height) pair against one class table.
function matchAspectInClass(
  width: number,
  height: number,
  sizeClass: SizeClass,
): AspectId | null {
  const table = dimsTable(sizeClass)
  for (const aspect of ASPECT_IDS) {
    const entry = table[aspect]
    if (entry[0] === width && entry[1] === height) return aspect
  }
  return null
}

// The size class to use for a tweak dims override when size is CUSTOM (null):
// inherit the base's class by exact-matching its dims against the 256 table; any miss
// (including non-preset base dims) falls to the 512 class — the full class,
// never a guess at a third size.
function tweakDimsClass(size: SizeId | null, baseValues: Record<string, unknown>): SizeClass {
  if (size != null) return SIZE_CLASS[size]
  const width = baseValues['width']
  const height = baseValues['height']
  if (typeof width === 'number' && typeof height === 'number' && matchAspectInClass(width, height, 256) != null) {
    return 256
  }
  return 512
}

// The dims the submission will actually render at — the optimistic tile's aspect must
// match the session tile that replaces it. Mirrors composeSubmission's dims rule: concrete
// aspect resolves against the (size- or base-derived) class table; a tweak CUSTOM
// aspect inherits the base dims; a base without numeric dims falls to 512x512.
export function composerDims(composer: ComposerSubmitInput): { width: number; height: number } {
  if (composer.tweak == null) {
    if (composer.aspect == null || composer.size == null) {
      throw new Error('composerDims: a fresh composer must have concrete preset ids')
    }
    if (composer.aspect === 'auto') return autoAspectDims(composer, SIZE_CLASS[composer.size])
    return resolveDims(composer.aspect, composer.size)
  }
  if (composer.aspect != null) {
    const sizeClass = tweakDimsClass(composer.size, composer.tweak.baseValues)
    if (composer.aspect === 'auto') return autoAspectDims(composer, sizeClass)
    const entry = dimsTable(sizeClass)[composer.aspect]
    return { width: entry[0], height: entry[1] }
  }
  const width = composer.tweak.baseValues['width']
  const height = composer.tweak.baseValues['height']
  if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
    return { width, height }
  }
  return { width: 512, height: 512 }
}

export function composeSubmission(composer: ComposerSubmitInput): SubmissionPayload {
  const prompt = composer.prompt.trim()
  if (prompt === '') throw new Error('composeSubmission: empty prompt (caller must guard)')
  if (!Number.isInteger(composer.steps) || composer.steps < 1) {
    // The three steps boundaries (parseStepsId, parseCustomSteps, rematerializeSteps)
    // guarantee a positive integer — anything else is a caller-contract violation.
    throw new Error(`composeSubmission: invalid steps ${composer.steps} (must be a positive integer)`)
  }
  const seedLocked = composer.seedMode.kind === 'locked'

  if (composer.tweak == null) {
    if (composer.aspect == null || composer.size == null || composer.look == null) {
      throw new Error('composeSubmission: a fresh composer must have concrete preset ids')
    }
    const dims =
      composer.aspect === 'auto'
        ? autoAspectDims(composer, SIZE_CLASS[composer.size])
        : resolveDims(composer.aspect, composer.size)
    const values: Record<string, unknown> = {
      scenes: prompt,
      width: dims.width,
      height: dims.height,
      steps_per_scene: composer.steps,
      image_model: lookModel(composer.look),
      // Create is a stills surface by construction: pin animation off —
      // self-containment must hold regardless of what the tuned defaults
      // carry, and the mlx_full default engine refuses animation configs.
      animation_mode: 'off',
      // auto_stop deliberately NOT pinned: the plateau detector was
      // calibrated on classic-ensemble loss curves and fires mid-render on
      // the modern pair's flat spells (cut renders at 129/200 in live use,
      // 2026-08-03). Re-enable when the detector judges the semantic
      // component with consecutive-verdict confirmation.
      // No prompt ramp on a single scene: the tuned defaults'
      // interpolation_steps (50) otherwise scales the prompt in over the
      // first steps, ceding the composition-forming window to TV smoothing.
      interpolation_steps: 0,
    }
    // Pyramid rendering (full-tier battery, 2026-08-05: pyramid3 beat
    // single-stage 16W/4L on the eye-calibrated judge, no texture penalty
    // per ViT-L/14; compare sheets confirmed by eye): thumbnail -> half ->
    // full, composition observed before it is refined. The engine refuses
    // c2f + semantic init, so HOLD MEANING sessions stay plain-render.
    if (composer.init == null || !composer.init.holdMeaning) {
      values['coarse_to_fine'] = true
      values['coarse_stages'] = 3
    }
    if (composer.seedMode.kind === 'locked') values['seed'] = composer.seedMode.seed
    // Init (§15.6): with no attachment NONE of the four keys appear (ruling 5 — schema
    // defaults cover absence; never emit empty-string init keys).
    const init = composer.init
    if (init != null) {
      if (init.strength == null) {
        throw new Error('composeSubmission: fresh init with null strength (unreachable per §15.4 bar-clear rule)')
      }
      values['init_image'] = init.path
      values['direct_init_weight'] = formatInitWeight(strengthWeight(init.strength), init.mask)
      if (init.holdMeaning) {
        values['semantic_init_weight'] = '4'
        values['perceptor_backend'] = 'torch' // semantic init is torch-only by design
      }
    }
    return { values, forkOf: null, seedLocked }
  }

  // Tweak: base snapshot values, overridden only where the user picked a concrete chip.
  const values: Record<string, unknown> = {}
  for (const key of Object.keys(composer.tweak.baseValues)) {
    values[key] = composer.tweak.baseValues[key]
  }
  values['scenes'] = prompt
  if (composer.aspect != null) {
    const sizeClass = tweakDimsClass(composer.size, composer.tweak.baseValues)
    let dims: { width: number; height: number }
    if (composer.aspect === 'auto') {
      dims = autoAspectDims(composer, sizeClass)
    } else {
      const entry = dimsTable(sizeClass)[composer.aspect]
      dims = { width: entry[0], height: entry[1] }
    }
    values['width'] = dims.width
    values['height'] = dims.height
  }
  // Steps always carries the composer's concrete number: tweakSession rematerialized
  // the base's count into it, so an untouched tweak submits the base verbatim (§5.3).
  values['steps_per_scene'] = composer.steps
  if (composer.look != null) values['image_model'] = lookModel(composer.look)
  switch (composer.seedMode.kind) {
    case 'locked':
      values['seed'] = composer.seedMode.seed
      break
    case 'random':
      // random = the submission omits seed entirely; the server rolls fresh
      delete values['seed']
      break
  }

  // Init (§15.6, tweak): base values ride; override only where the composer differs.
  const init = composer.init
  if (init == null) {
    // User removed the chip: the server's defaults-compose restores schema defaults
    // (same mechanism as random-seed's delete). perceptor_backend stays — a base's
    // deliberate backend choice is not Create's to revert.
    delete values['init_image']
    delete values['direct_init_weight']
    delete values['semantic_init_weight']
  } else {
    values['init_image'] = init.path // unconditional — cheap, correct
    const base = parseInitWeight(String(composer.tweak.baseValues['direct_init_weight'] ?? ''))
    // direct: no override when strength inherits AND the mask state equals the base's
    // (simple with same path+inverted, or an untouched opaque/none base — mask editing
    // is locked there, §15.4). This is how a bench cutoff survives a tweak untouched.
    const maskUntouched = base.kind === 'simple' ? sameMask(init.mask, base.mask) : init.mask == null
    if (init.strength != null || !maskUntouched) {
      let weight: string
      if (init.strength != null) {
        weight = strengthWeight(init.strength)
      } else {
        // Recomposing with an inherited weight requires a simple base by construction
        // (mask editing is locked on opaque bases — §15.6 assert).
        if (base.kind !== 'simple') {
          throw new Error('composeSubmission: mask changed over a non-simple base weight (mask editing must be locked)')
        }
        weight = base.weight
      }
      values['direct_init_weight'] = formatInitWeight(weight, init.mask)
    }
    // semantic: no override while the toggle matches the base (a non-0.3 base value
    // rides verbatim); toggled on -> '4'; toggled off -> delete.
    const baseOn = semanticOn(composer.tweak.baseValues)
    if (init.holdMeaning !== baseOn) {
      if (init.holdMeaning) values['semantic_init_weight'] = '4'
      else delete values['semantic_init_weight']
    }
    // backend: pinned unconditionally while hold is on (covers legacy/imported bases
    // whose snapshot lacks a backend); off -> untouched.
    if (init.holdMeaning) values['perceptor_backend'] = 'torch'
  }

  return { values, forkOf: composer.tweak.of, seedLocked }
}

export function matchPresets(values: Record<string, unknown>): {
  aspect: AspectId | null
  size: SizeId | null
  look: LookId | null
} {
  const width = values['width']
  const height = values['height']
  let aspect: AspectId | null = null
  let size: SizeId | null = null
  if (typeof width === 'number' && typeof height === 'number') {
    // aspect and size come from the SAME exact dims match — a pair in the 256 table is
    // draft, in the 512 table full; a miss leaves both CUSTOM (never one without the other).
    const in256 = matchAspectInClass(width, height, 256)
    const in512 = matchAspectInClass(width, height, 512)
    if (in256 != null) {
      aspect = in256
      size = 'draft'
    } else if (in512 != null) {
      aspect = in512
      size = 'full'
    }
  }

  // Steps is deliberately absent: it is no longer a preset-matched control — the base's
  // steps_per_scene rematerializes as a plain number via rematerializeSteps (§5.3).

  const model = values['image_model']
  let look: LookId | null = null
  if (typeof model === 'string') {
    for (const l of LOOK_IDS) {
      if (LOOK[l] === model) {
        look = l
        break
      }
    }
  }

  return { aspect, size, look }
}

// Keep only keys the config schema knows — parse-at-the-boundary: a snapshot key the
// self-contained POST's coercion would 400 on never leaves the client.
export function submittableValues(
  config: Record<string, unknown>,
  schemaFields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of schemaFields) {
    if (key in config) out[key] = config[key]
  }
  return out
}
