// @cs
// create/core/presets: THE preset tables (aspect / quality / look / seed) and the two
// maps across them — composeSubmission (composer -> the self-contained POST /api/sessions
// payload; the server composes it over the versioned tuned defaults, spec §5.6) and
// matchPresets (config snapshot -> preset ids, exact-match only). Also
// submittableValues, the schema-whitelist filter that keeps a snapshot key the server's
// coercion would 400 on from ever leaving the client. Create never touches /api/draft —
// the shared draft is the advanced bench's private working state.
//
// String/JSON domain — outside freerange's numeric subset; presets.test.ts is the
// checked surface.
//
// types:
//   AspectId = '1:1'|'3:4'|'4:3'|'16:9'    QualityId = 'draft'|'standard'|'deep'
//   LookId = 'limited'|'unlimited'|'vqgan' SeedMode = {kind:'random'} | {kind:'locked', seed}
//   ComposerSubmitInput = { prompt, aspect|null, quality|null, look|null, seedMode, tweak|null,
//     init: InitSubmitInput|null }   (null preset ids = "inherit tweak base", reachable
//     only while tweak != null; init per §15.6 — main maps the attachment through
//     core/init toInitSubmitInput, which enforces the image-is-ready contract)
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
//   resolveDims(aspect, quality) -> {width, height}     pure table lookup
//   qualitySteps(quality) -> steps_per_scene            draft 150 / standard 200 / deep 300
//   lookModel(look) -> image_model string
//   composeSubmission(composer) -> SubmissionPayload    throws on empty prompt or a fresh
//     composer with null ids (caller-contract violations). Tweak dims rule: width/height
//     override only when aspect != null; its size class comes from quality when non-null,
//     else from exact-matching the BASE dims against the 256 table (miss -> 512 class).
//     Init rule (§15.6): fresh emits init_image + formatInitWeight (+ semantic '4' and
//     perceptor_backend torch iff holdMeaning); no attachment -> keys ABSENT, never ''.
//     Tweak overrides only on diff (an untouched simple/opaque base weight rides
//     verbatim, preserving bench cutoffs); chip removal deletes the three init keys
//     (perceptor_backend untouched); holdMeaning pins torch unconditionally when on.
//   composerDims(composer) -> {width, height}          the dims the submission renders at
//     (optimistic tile sizing); same dims rule as composeSubmission, base-dims fallback 512x512
//   matchPresets(values) -> {aspect|null, quality|null, look|null}   exact-match only,
//     no nearest-neighbor guessing; quality requires steps in {150,200,300} AND its class
//     to match the dims-derived class
//   submittableValues(config, schemaFields) -> Record       whitelist filter
// @/cs
import {
  formatInitWeight,
  type InitSubmitInput,
  parseInitWeight,
  sameMask,
  semanticOn,
  strengthWeight,
} from './init'

export type AspectId = '1:1' | '3:4' | '4:3' | '16:9'
export type QualityId = 'draft' | 'standard' | 'deep'
export type LookId = 'limited' | 'unlimited' | 'vqgan'
export type SeedMode = { kind: 'random' } | { kind: 'locked'; seed: number }

export const ASPECT_IDS: readonly AspectId[] = ['1:1', '3:4', '4:3', '16:9']
export const QUALITY_IDS: readonly QualityId[] = ['draft', 'standard', 'deep']
export const LOOK_IDS: readonly LookId[] = ['limited', 'unlimited', 'vqgan']

type SizeClass = 256 | 512

// aspect -> [width, height] per size class. Quality picks the class; aspect the shape.
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

const QUALITY: Record<QualityId, { steps: number; sizeClass: SizeClass }> = {
  draft: { steps: 150, sizeClass: 256 },
  standard: { steps: 200, sizeClass: 512 },
  deep: { steps: 300, sizeClass: 512 },
}

const LOOK: Record<LookId, string> = {
  limited: 'Limited Palette',
  unlimited: 'Unlimited Palette',
  vqgan: 'VQGAN',
}

// Popover display labels.
export const QUALITY_LABELS: Record<QualityId, string> = { draft: 'DRAFT', standard: 'STANDARD', deep: 'DEEP' }
export const LOOK_LABELS: Record<LookId, string> = { limited: 'LIMITED', unlimited: 'UNLIMITED', vqgan: 'VQGAN' }

function dimsTable(sizeClass: SizeClass): Record<AspectId, readonly [number, number]> {
  return sizeClass === 256 ? DIMS_256 : DIMS_512
}

export function resolveDims(aspect: AspectId, quality: QualityId): { width: number; height: number } {
  const entry = dimsTable(QUALITY[quality].sizeClass)[aspect]
  return { width: entry[0], height: entry[1] }
}

export function qualitySteps(quality: QualityId): number {
  return QUALITY[quality].steps
}

export function lookModel(look: LookId): string {
  return LOOK[look]
}

export type ComposerSubmitInput = {
  prompt: string
  aspect: AspectId | null
  quality: QualityId | null
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
  'width', // ASPECT x QUALITY chips (dims table, §5.1)
  'height', // ASPECT x QUALITY chips
  'steps_per_scene', // QUALITY chips
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

// The size class to use for a tweak dims override when quality is CUSTOM (null):
// inherit the base's class by exact-matching its dims against the 256 table; any miss
// (including non-preset base dims) falls to the 512 class — the standard/deep class,
// never a guess at a third size.
function tweakDimsClass(quality: QualityId | null, baseValues: Record<string, unknown>): SizeClass {
  if (quality != null) return QUALITY[quality].sizeClass
  const width = baseValues['width']
  const height = baseValues['height']
  if (typeof width === 'number' && typeof height === 'number' && matchAspectInClass(width, height, 256) != null) {
    return 256
  }
  return 512
}

// The dims the submission will actually render at — the optimistic tile's aspect must
// match the session tile that replaces it. Mirrors composeSubmission's dims rule: concrete
// aspect resolves against the (quality- or base-derived) class table; a tweak CUSTOM
// aspect inherits the base dims; a base without numeric dims falls to 512x512.
export function composerDims(composer: ComposerSubmitInput): { width: number; height: number } {
  if (composer.tweak == null) {
    if (composer.aspect == null || composer.quality == null) {
      throw new Error('composerDims: a fresh composer must have concrete preset ids')
    }
    return resolveDims(composer.aspect, composer.quality)
  }
  if (composer.aspect != null) {
    const entry = dimsTable(tweakDimsClass(composer.quality, composer.tweak.baseValues))[composer.aspect]
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
  const seedLocked = composer.seedMode.kind === 'locked'

  if (composer.tweak == null) {
    if (composer.aspect == null || composer.quality == null || composer.look == null) {
      throw new Error('composeSubmission: a fresh composer must have concrete preset ids')
    }
    const dims = resolveDims(composer.aspect, composer.quality)
    const values: Record<string, unknown> = {
      scenes: prompt,
      width: dims.width,
      height: dims.height,
      steps_per_scene: qualitySteps(composer.quality),
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
    const entry = dimsTable(tweakDimsClass(composer.quality, composer.tweak.baseValues))[composer.aspect]
    values['width'] = entry[0]
    values['height'] = entry[1]
  }
  if (composer.quality != null) values['steps_per_scene'] = qualitySteps(composer.quality)
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
  quality: QualityId | null
  look: LookId | null
} {
  const width = values['width']
  const height = values['height']
  let aspect: AspectId | null = null
  let matchedClass: SizeClass | null = null
  if (typeof width === 'number' && typeof height === 'number') {
    const in256 = matchAspectInClass(width, height, 256)
    const in512 = matchAspectInClass(width, height, 512)
    if (in256 != null) {
      aspect = in256
      matchedClass = 256
    } else if (in512 != null) {
      aspect = in512
      matchedClass = 512
    }
  }

  const steps = values['steps_per_scene']
  let quality: QualityId | null = null
  if (typeof steps === 'number' && matchedClass != null) {
    for (const q of QUALITY_IDS) {
      if (QUALITY[q].steps === steps && QUALITY[q].sizeClass === matchedClass) {
        quality = q
        break
      }
    }
  }

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

  return { aspect, quality, look }
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
