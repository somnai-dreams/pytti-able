import { describe, expect, test } from 'bun:test'
import {
  deriveInitFromBase,
  formatInitWeight,
  initNaturalDims,
  maskEditingLocked,
  matchStrength,
  parseInitWeight,
  sameMask,
  semanticOn,
  strengthWeight,
  toInitSubmitInput,
} from './init'

describe('strength table', () => {
  test('the exact values (spec §15.5)', () => {
    expect(strengthWeight('subtle')).toBe('1.5')
    expect(strengthWeight('medium')).toBe('4')
    expect(strengthWeight('strong')).toBe('10')
  })
})

describe('formatInitWeight', () => {
  test('no mask -> the weight alone', () => {
    expect(formatInitWeight('4', null)).toBe('4')
  })
  test('mask -> bracketed path', () => {
    expect(formatInitWeight('4', { path: '/abs/mask.png', inverted: false })).toBe('4_[/abs/mask.png]')
  })
  test("inversion '-' goes INSIDE the bracket (engine grammar)", () => {
    expect(formatInitWeight('10', { path: '/abs/mask.png', inverted: true })).toBe('10_[-/abs/mask.png]')
  })
})

describe('parseInitWeight', () => {
  test("'' and whitespace -> none", () => {
    expect(parseInitWeight('')).toEqual({ kind: 'none' })
    expect(parseInitWeight('  ')).toEqual({ kind: 'none' })
  })
  test('plain-number zero -> none', () => {
    expect(parseInitWeight('0')).toEqual({ kind: 'none' })
    expect(parseInitWeight('0.0')).toEqual({ kind: 'none' })
  })
  test('plain weight -> simple, no mask', () => {
    expect(parseInitWeight('4')).toEqual({ kind: 'simple', weight: '4', mask: null })
    expect(parseInitWeight('1')).toEqual({ kind: 'simple', weight: '1', mask: null })
  })
  test('non-numeric weight expression stays simple (weights are expression strings)', () => {
    expect(parseInitWeight('sin(t)')).toEqual({ kind: 'simple', weight: 'sin(t)', mask: null })
  })
  test('bracketed image mask -> simple with mask', () => {
    expect(parseInitWeight('4_[/abs/mask.png]')).toEqual({
      kind: 'simple',
      weight: '4',
      mask: { path: '/abs/mask.png', inverted: false },
    })
  })
  test("'-' inside the bracket -> inverted", () => {
    expect(parseInitWeight('4_[-/abs/mask.png]')).toEqual({
      kind: 'simple',
      weight: '4',
      mask: { path: '/abs/mask.png', inverted: true },
    })
  })
  test("'-' outside the bracket (parse_mask_token's other position) -> inverted too", () => {
    expect(parseInitWeight('0.3_-[/abs/mask.png]')).toEqual({
      kind: 'simple',
      weight: '0.3',
      mask: { path: '/abs/mask.png', inverted: true },
    })
  })
  test('jpeg/webp/bmp suffixes parse as image masks', () => {
    expect(parseInitWeight('1_[/a/b.JPG]').kind).toBe('simple')
    expect(parseInitWeight('1_[/a/b.webp]').kind).toBe('simple')
    expect(parseInitWeight('1_[/a/b.bmp]').kind).toBe('simple')
  })
  test('cutoff field -> opaque', () => {
    expect(parseInitWeight('1_r_0.3')).toEqual({ kind: 'opaque', raw: '1_r_0.3' })
    expect(parseInitWeight('4_[/abs/mask.png]_0.5')).toEqual({ kind: 'opaque', raw: '4_[/abs/mask.png]_0.5' })
  })
  test('video mask -> opaque', () => {
    expect(parseInitWeight('4_[/abs/mask.mp4]').kind).toBe('opaque')
  })
  test('geometric / semantic / bare-path mask tokens -> opaque', () => {
    expect(parseInitWeight('0.3_r').kind).toBe('opaque')
    expect(parseInitWeight('0.3_a fern').kind).toBe('opaque')
    expect(parseInitWeight('0.3_/abs/mask.png').kind).toBe('opaque')
  })
  test('engine-defaulted empty weight before a mask -> opaque', () => {
    expect(parseInitWeight('_[/abs/mask.png]').kind).toBe('opaque')
  })
})

describe('matchStrength', () => {
  test('the three preset strings match exactly', () => {
    expect(matchStrength('1.5')).toBe('subtle')
    expect(matchStrength('4')).toBe('medium')
    expect(matchStrength('10')).toBe('strong')
  })
  test('no normalization, no nearest-neighbor (§5.3 doctrine)', () => {
    expect(matchStrength('0.30')).toBeNull()
    expect(matchStrength('.3')).toBeNull()
    expect(matchStrength('0.45')).toBeNull()
    expect(matchStrength('')).toBeNull()
  })
})

describe('sameMask', () => {
  test('null pairs and value pairs', () => {
    expect(sameMask(null, null)).toBe(true)
    expect(sameMask(null, { path: '/m.png', inverted: false })).toBe(false)
    expect(sameMask({ path: '/m.png', inverted: false }, { path: '/m.png', inverted: false })).toBe(true)
    expect(sameMask({ path: '/m.png', inverted: false }, { path: '/m.png', inverted: true })).toBe(false)
    expect(sameMask({ path: '/m.png', inverted: false }, { path: '/n.png', inverted: false })).toBe(false)
  })
})

describe('semanticOn', () => {
  test("off for absent, '', '0', numeric 0", () => {
    expect(semanticOn({})).toBe(false)
    expect(semanticOn({ semantic_init_weight: '' })).toBe(false)
    expect(semanticOn({ semantic_init_weight: '0' })).toBe(false)
    expect(semanticOn({ semantic_init_weight: 0 })).toBe(false)
  })
  test('on for any other value, string or number', () => {
    expect(semanticOn({ semantic_init_weight: '4' })).toBe(true)
    expect(semanticOn({ semantic_init_weight: 1 })).toBe(true)
  })
})

describe('initNaturalDims (§5.1a — the AUTO aspect enabling fact)', () => {
  test('null without an attachment, while uploading, and while dims are unknown', () => {
    expect(initNaturalDims(null)).toBeNull()
    expect(
      initNaturalDims({
        image: { kind: 'uploading', name: 'a.png', localUrl: 'blob:x' },
        strength: 'medium',
        holdMeaning: false,
        mask: null,
      }),
    ).toBeNull()
    expect(
      initNaturalDims({
        image: { kind: 'ready', name: 'a.png', path: '/up/a.png', localUrl: null, natural: null },
        strength: 'medium',
        holdMeaning: false,
        mask: null,
      }),
    ).toBeNull()
  })
  test('the dims once a ready image knows them', () => {
    expect(
      initNaturalDims({
        image: { kind: 'ready', name: 'a.png', path: '/up/a.png', localUrl: 'blob:x', natural: { width: 1200, height: 800 } },
        strength: 'medium',
        holdMeaning: false,
        mask: null,
      }),
    ).toEqual({ width: 1200, height: 800 })
  })
})

describe('toInitSubmitInput', () => {
  test('null passes through', () => {
    expect(toInitSubmitInput(null)).toBeNull()
  })
  test('ready image maps to the draft view, natural dims riding along (§5.1a)', () => {
    expect(
      toInitSubmitInput({
        image: { kind: 'ready', name: 'a.png', path: '/up/a.png', localUrl: 'blob:x', natural: { width: 1200, height: 800 } },
        strength: 'medium',
        holdMeaning: true,
        mask: { path: '/up/m.png', inverted: true },
      }),
    ).toEqual({
      path: '/up/a.png',
      natural: { width: 1200, height: 800 },
      strength: 'medium',
      holdMeaning: true,
      mask: { path: '/up/m.png', inverted: true },
    })
  })
  test('uploading image throws (A1 guard is the caller contract)', () => {
    expect(() =>
      toInitSubmitInput({
        image: { kind: 'uploading', name: 'a.png', localUrl: 'blob:x' },
        strength: 'medium',
        holdMeaning: false,
        mask: null,
      }),
    ).toThrow()
  })
})

describe('maskEditingLocked', () => {
  test('concrete strength always unlocks (opaque tail deliberately dropped)', () => {
    expect(maskEditingLocked('medium', { direct_init_weight: '1_r_0.3' })).toBe(false)
  })
  test('null strength on a simple base stays unlocked (CUSTOM weight, editable mask)', () => {
    expect(maskEditingLocked(null, { direct_init_weight: '0.45' })).toBe(false)
    expect(maskEditingLocked(null, { direct_init_weight: '4_[/m.png]' })).toBe(false)
  })
  test('null strength on an opaque or empty base locks', () => {
    expect(maskEditingLocked(null, { direct_init_weight: '1_r_0.3' })).toBe(true)
    expect(maskEditingLocked(null, { direct_init_weight: '' })).toBe(true)
    expect(maskEditingLocked(null, {})).toBe(true)
  })
})

describe('deriveInitFromBase (§15.8)', () => {
  test('empty init_image -> null', () => {
    expect(deriveInitFromBase({})).toBeNull()
    expect(deriveInitFromBase({ init_image: '' })).toBeNull()
    expect(deriveInitFromBase({ init_image: 42 })).toBeNull()
  })
  test('preset weight rematerializes strength + mask + hold; natural starts null (async load, §15.8)', () => {
    expect(
      deriveInitFromBase({
        init_image: '/up/tree.png',
        direct_init_weight: '4_[-/up/mask-tree.png]',
        semantic_init_weight: '4',
      }),
    ).toEqual({
      image: { kind: 'ready', name: 'tree.png', path: '/up/tree.png', localUrl: null, natural: null },
      strength: 'medium',
      holdMeaning: true,
      mask: { path: '/up/mask-tree.png', inverted: true },
    })
  })
  test('non-preset simple weight -> CUSTOM (strength null), mask still carried', () => {
    const init = deriveInitFromBase({ init_image: '/up/a.png', direct_init_weight: '0.45' })
    expect(init).not.toBeNull()
    expect(init!.strength).toBeNull()
    expect(init!.mask).toBeNull()
    expect(init!.holdMeaning).toBe(false)
  })
  test('opaque bench weight -> CUSTOM, no mask (affordance locked at the surface)', () => {
    const init = deriveInitFromBase({ init_image: '/elsewhere/a.png', direct_init_weight: '1_r_0.3' })
    expect(init!.strength).toBeNull()
    expect(init!.mask).toBeNull()
    expect(maskEditingLocked(init!.strength, { direct_init_weight: '1_r_0.3' })).toBe(true)
  })
  test('numeric legacy weight values are stringified before parsing', () => {
    const init = deriveInitFromBase({ init_image: '/up/a.png', direct_init_weight: 4 })
    expect(init!.strength).toBe('medium')
  })
})
