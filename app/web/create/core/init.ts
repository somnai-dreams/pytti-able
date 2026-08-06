// @cs
// create/core/init: the image-input attachment model (spec §15) and Create's subset of
// the engine's weight_mask grammar (pytti-core prompt_spec.py parse_weight_spec /
// parse_mask_token): "<weight>_[<abs path>]", '-' INSIDE the bracket prefixing the path
// for inversion. A third '_' field is a cutoff expression — Create never emits one and
// classifies any such string as opaque (it rides a tweak verbatim, never recomposed).
//
// String domain — outside freerange's numeric subset; init.test.ts is the checked
// surface.
//
// types:
//   InitStrengthId = 'subtle' | 'medium' | 'strong'   (1.5 / 4 / 10)
//   NaturalDims = { width, height }                    the image file's own pixel dims
//   InitImage   — uploading (object URL only) | ready (abs upload path; localUrl null
//                 when rematerialized from a tweak base — display via api.uploadUrl;
//                 natural null until the dom reads the pixels — fresh attaches read it
//                 from the object URL before 'ready', rematerialized ones load it async
//                 via uploadUrl and it stays null on a 404/undecodable file)
//   InitMask    = { path, inverted }                   abs path of the mask PNG upload
//   InitAttachment = { image, strength|null, holdMeaning, mask|null }
//     strength null = CUSTOM (inherit the base's weight expression) — reachable ONLY
//     while composer.tweak != null, mirroring aspect/size/steps/look
//   InitSubmitInput = { path, natural|null, strength|null, holdMeaning, mask|null }
//     composeSubmission's view (natural feeds the AUTO aspect's dims, §5.1a)
//   ParsedInitWeight = none | simple{weight, mask|null} | opaque{raw}
//
// functions:
//   strengthWeight(id) -> '1.5' | '4' | '10'
//   initNaturalDims(init) -> NaturalDims | null      the AUTO aspect's enabling fact:
//     non-null iff an attachment exists, is ready, and its pixel dims are known
//   formatInitWeight(weight, mask) -> string          the compose half of the codec
//   parseInitWeight(raw) -> ParsedInitWeight          '' / plain-number zero -> none;
//     plain weight expr + at most one BRACKETED image-path mask (either '-' position)
//     -> simple; cutoff fields, video/semantic/geometric masks, bare paths -> opaque
//   matchStrength(weight) -> InitStrengthId | null    exact match on the three preset
//     strings only — no nearest-neighbor (§5.3 doctrine)
//   sameMask(a, b) -> boolean
//   semanticOn(values) -> boolean                     semantic_init_weight not in {'','0'}
//   toInitSubmitInput(init) -> InitSubmitInput | null   throws while image is uploading
//                                                     (A1 guard is the caller contract)
//   deriveInitFromBase(baseValues) -> InitAttachment | null   A4 rematerialization:
//     empty init_image -> null; strength from matchStrength when the base weight parses
//     simple (miss -> null = CUSTOM); opaque/none base -> strength null (MASK affordance
//     disabled at the surface via maskEditingLocked); holdMeaning = semanticOn
//   maskEditingLocked(strength, baseValues) -> boolean  strength null AND the base weight
//     is not simple — the §15.6 recompose assert made unreachable by construction
// @/cs

export type InitStrengthId = 'subtle' | 'medium' | 'strong'

export const INIT_STRENGTH_IDS: readonly InitStrengthId[] = ['subtle', 'medium', 'strong']

const STRENGTH: Record<InitStrengthId, string> = { subtle: '1.5', medium: '4', strong: '10' }

export function strengthWeight(id: InitStrengthId): string {
  return STRENGTH[id]
}

export type NaturalDims = { width: number; height: number }

export type InitImage =
  | { kind: 'uploading'; name: string; localUrl: string }
  | { kind: 'ready'; name: string; path: string; localUrl: string | null; natural: NaturalDims | null }

export type InitMask = { path: string; inverted: boolean }

export type InitAttachment = {
  image: InitImage
  strength: InitStrengthId | null
  holdMeaning: boolean
  mask: InitMask | null
}

export type InitSubmitInput = {
  path: string
  natural: NaturalDims | null
  strength: InitStrengthId | null
  holdMeaning: boolean
  mask: InitMask | null
}

export type ParsedInitWeight =
  | { kind: 'none' }
  | { kind: 'simple'; weight: string; mask: InitMask | null }
  | { kind: 'opaque'; raw: string }

// mask == null -> the weight rides alone; else the bracketed mask token with the
// inversion '-' INSIDE the bracket (prompt_spec.py parse_mask_token line 126-128).
export function formatInitWeight(weight: string, mask: InitMask | null): string {
  if (mask == null) return weight
  return `${weight}_[${mask.inverted ? '-' : ''}${mask.path}]`
}

// Suffixes parse_mask_token maps to MaskImage (mp4 is MaskVideo -> opaque).
const IMAGE_SUFFIXES = ['.png', '.jpg', '.jpeg', '.bmp', '.webp']

function hasImageSuffix(path: string): boolean {
  const lower = path.toLowerCase()
  for (const suffix of IMAGE_SUFFIXES) {
    if (lower.endsWith(suffix)) return true
  }
  return false
}

// Split on '_' at bracket depth zero — the engine's split_toplevel, Create's subset
// (no maxsplit: we only classify, and 3+ fields is opaque regardless).
function splitTopLevel(raw: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '[') depth += 1
    else if (ch === ']') depth = depth > 0 ? depth - 1 : 0
    else if (ch === '_' && depth === 0) {
      parts.push(raw.slice(start, i))
      start = i + 1
    }
  }
  parts.push(raw.slice(start))
  return parts
}

// A plain number token (the only weights matchStrength and the zero->none rule see).
function isPlainNumber(token: string): boolean {
  return token !== '' && !Number.isNaN(Number(token))
}

export function parseInitWeight(raw: string): ParsedInitWeight {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'none' }
  const parts = splitTopLevel(trimmed)
  if (parts.length === 1) {
    const weight = parts[0]!.trim()
    if (isPlainNumber(weight) && Number(weight) === 0) return { kind: 'none' }
    return { kind: 'simple', weight, mask: null }
  }
  if (parts.length !== 2) return { kind: 'opaque', raw: trimmed } // cutoff field present
  const weight = parts[0]!.trim()
  if (weight === '') return { kind: 'opaque', raw: trimmed } // engine-defaulted weight — bench-authorable, not Create's
  let token = parts[1]!.trim()
  let inverted = false
  if (token.startsWith('-')) {
    // '-' outside the bracket (parse_mask_token strips it before the bracket check)
    inverted = true
    token = token.slice(1)
  }
  if (!(token.startsWith('[') && token.endsWith(']'))) return { kind: 'opaque', raw: trimmed }
  let inner = token.slice(1, -1).trim()
  if (inner.startsWith('-')) {
    inverted = true
    inner = inner.slice(1)
  }
  if (!hasImageSuffix(inner)) return { kind: 'opaque', raw: trimmed } // video/semantic/geometric
  return { kind: 'simple', weight, mask: { path: inner, inverted } }
}

// Exact match on the three preset strings — plain-number strings only, no normalization.
export function matchStrength(weight: string): InitStrengthId | null {
  for (const id of INIT_STRENGTH_IDS) {
    if (STRENGTH[id] === weight) return id
  }
  return null
}

export function sameMask(a: InitMask | null, b: InitMask | null): boolean {
  if (a == null || b == null) return a == null && b == null
  return a.path === b.path && a.inverted === b.inverted
}

// baseOn (§15.6): semantic_init_weight not in {'', '0'} — legacy snapshots may carry
// numbers, so the value is stringified first.
export function semanticOn(values: Record<string, unknown>): boolean {
  const raw = String(values['semantic_init_weight'] ?? '').trim()
  return raw !== '' && raw !== '0'
}

// The AUTO aspect's enabling fact (§5.1a): the attachment's own pixel dims, known only
// once the dom layer has decoded them — null while uploading, while a rematerialized
// attachment's async load is in flight, or forever for an unreadable/404 image (AUTO
// just stays disabled — no spinner machinery).
export function initNaturalDims(init: InitAttachment | null): NaturalDims | null {
  if (init == null || init.image.kind !== 'ready') return null
  return init.image.natural
}

export function toInitSubmitInput(init: InitAttachment | null): InitSubmitInput | null {
  if (init == null) return null
  if (init.image.kind !== 'ready') {
    throw new Error('toInitSubmitInput: image still uploading (caller must guard, §15.4)')
  }
  return {
    path: init.image.path,
    natural: init.image.natural,
    strength: init.strength,
    holdMeaning: init.holdMeaning,
    mask: init.mask,
  }
}

// MASK is locked (not just visually disabled — the §15.6 recompose asserts base is
// simple) while the composer would inherit a non-simple base weight: strength null AND
// the base's direct_init_weight is opaque or none. Picking a concrete strength unlocks
// (the opaque tail is deliberately dropped on recompose).
export function maskEditingLocked(
  strength: InitStrengthId | null,
  baseValues: Record<string, unknown>,
): boolean {
  if (strength != null) return false
  return parseInitWeight(String(baseValues['direct_init_weight'] ?? '')).kind !== 'simple'
}

// A4 (Tweak) rematerialization — §15.8.
export function deriveInitFromBase(baseValues: Record<string, unknown>): InitAttachment | null {
  const rawPath = baseValues['init_image']
  if (typeof rawPath !== 'string' || rawPath === '') return null
  const base = parseInitWeight(String(baseValues['direct_init_weight'] ?? ''))
  const slash = rawPath.lastIndexOf('/')
  const name = slash >= 0 ? rawPath.slice(slash + 1) : rawPath
  return {
    // natural starts null — the snapshot carries no pixel dims; the dom layer loads
    // them async via uploadUrl (§15.8). AUTO stays disabled until they land.
    image: { kind: 'ready', name, path: rawPath, localUrl: null, natural: null },
    strength: base.kind === 'simple' ? matchStrength(base.weight) : null,
    holdMeaning: semanticOn(baseValues),
    mask: base.kind === 'simple' ? base.mask : null,
  }
}
