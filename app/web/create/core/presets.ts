// @cs
// create/core/presets: THE preset tables (aspect / quality / look / seed) and the two
// maps across them — composeDraft (composer -> draft PUT payload, overrides-over-defaults)
// and matchPresets (config snapshot -> preset ids, exact-match only). Also
// draftableValues, the schema-whitelist filter that keeps a snapshot key the draft PUT
// would 400 on from ever leaving the client.
//
// String/JSON domain — outside freerange's numeric subset; presets.test.ts is the
// checked surface.
//
// types:
//   AspectId = '1:1'|'3:4'|'4:3'|'16:9'    QualityId = 'draft'|'standard'|'deep'
//   LookId = 'limited'|'unlimited'|'vqgan' SeedMode = {kind:'random'} | {kind:'locked', seed}
//   ComposerDraftInput = { prompt, aspect|null, quality|null, look|null, seedMode, tweak|null }
//     (null preset ids = "inherit tweak base", reachable only while tweak != null)
//   DraftPayload = { values, forkOf, seedLocked }   — the PUT /api/draft body
//
// functions:
//   resolveDims(aspect, quality) -> {width, height}     pure table lookup
//   qualitySteps(quality) -> steps_per_scene            draft 150 / standard 200 / deep 300
//   lookModel(look) -> image_model string
//   composeDraft(composer) -> DraftPayload              throws on empty prompt or a fresh
//     composer with null ids (caller-contract violations). Tweak dims rule: width/height
//     override only when aspect != null; its size class comes from quality when non-null,
//     else from exact-matching the BASE dims against the 256 table (miss -> 512 class).
//   composerDims(composer) -> {width, height}          the dims the submission renders at
//     (optimistic tile sizing); same dims rule as composeDraft, base-dims fallback 512x512
//   matchPresets(values) -> {aspect|null, quality|null, look|null}   exact-match only,
//     no nearest-neighbor guessing; quality requires steps in {150,200,300} AND its class
//     to match the dims-derived class
//   draftableValues(config, draftFields) -> Record       whitelist filter
// @/cs

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

export type ComposerDraftInput = {
  prompt: string
  aspect: AspectId | null
  quality: QualityId | null
  look: LookId | null
  seedMode: SeedMode
  tweak: { of: string; baseValues: Record<string, unknown> } | null
}

export type DraftPayload = {
  values: Record<string, unknown>
  forkOf: string | null
  seedLocked: boolean
}

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
// match the session tile that replaces it. Mirrors composeDraft's dims rule: concrete
// aspect resolves against the (quality- or base-derived) class table; a tweak CUSTOM
// aspect inherits the base dims; a base without numeric dims falls to 512x512.
export function composerDims(composer: ComposerDraftInput): { width: number; height: number } {
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

export function composeDraft(composer: ComposerDraftInput): DraftPayload {
  const prompt = composer.prompt.trim()
  if (prompt === '') throw new Error('composeDraft: empty prompt (caller must guard)')
  const seedLocked = composer.seedMode.kind === 'locked'

  if (composer.tweak == null) {
    if (composer.aspect == null || composer.quality == null || composer.look == null) {
      throw new Error('composeDraft: a fresh composer must have concrete preset ids')
    }
    const dims = resolveDims(composer.aspect, composer.quality)
    const values: Record<string, unknown> = {
      scenes: prompt,
      width: dims.width,
      height: dims.height,
      steps_per_scene: qualitySteps(composer.quality),
      image_model: lookModel(composer.look),
      // Create is a stills surface by construction: pin animation off so a
      // leftover animation_mode in the shared draft cannot leak into fresh
      // submissions (the mlx_full default engine refuses animation configs).
      animation_mode: 'off',
    }
    if (composer.seedMode.kind === 'locked') values['seed'] = composer.seedMode.seed
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
      // random = the draft omits seed entirely; the server rolls fresh
      delete values['seed']
      break
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

// Keep only keys the draft schema knows — parse-at-the-boundary: a snapshot key the
// draft PUT would 400 on never leaves the client.
export function draftableValues(
  config: Record<string, unknown>,
  draftFields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of draftFields) {
    if (key in config) out[key] = config[key]
  }
  return out
}
