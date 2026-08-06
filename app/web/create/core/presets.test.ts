import { describe, expect, test } from 'bun:test'
import {
  ASPECT_IDS,
  autoDims,
  composeSubmission,
  composerDims,
  LOOK_IDS,
  lookModel,
  matchPresets,
  parseStepsId,
  PIN_FIELDS,
  resolveDims,
  SIZE_IDS,
  STEPS_IDS,
  submittableValues,
  VISIBLE_CONTROL_FIELDS,
} from './presets'

describe('resolveDims', () => {
  test('the exact table (spec §5.1) — draft = 256-class, full = 512-class', () => {
    expect(resolveDims('1:1', 'draft')).toEqual({ width: 256, height: 256 })
    expect(resolveDims('3:4', 'draft')).toEqual({ width: 224, height: 288 })
    expect(resolveDims('4:3', 'draft')).toEqual({ width: 288, height: 224 })
    expect(resolveDims('16:9', 'draft')).toEqual({ width: 320, height: 180 })
    expect(resolveDims('1:1', 'full')).toEqual({ width: 512, height: 512 })
    expect(resolveDims('3:4', 'full')).toEqual({ width: 448, height: 576 })
    expect(resolveDims('4:3', 'full')).toEqual({ width: 576, height: 448 })
    expect(resolveDims('16:9', 'full')).toEqual({ width: 640, height: 360 })
  })
})

describe('autoDims (§5.1a — AR from the attachment, area from the size class)', () => {
  test('square attachment reproduces the 1:1 table pair exactly (budget = class²)', () => {
    expect(autoDims({ width: 1000, height: 1000 }, 512, 8)).toEqual({ width: 512, height: 512 })
    expect(autoDims({ width: 3000, height: 3000 }, 256, 8)).toEqual({ width: 256, height: 256 })
    expect(autoDims({ width: 512, height: 512 }, 512, 16)).toEqual({ width: 512, height: 512 })
  })
  test('AR preserved, both dims on the multiple, area near the budget (16:9 photo)', () => {
    // ideal 682.7 x 384; ÷8 rounds to 680 x 384 — 0.4% off the true AR, area 261120 ≈ 512²
    expect(autoDims({ width: 1920, height: 1080 }, 512, 8)).toEqual({ width: 680, height: 384 })
    // ÷16: 688 x 384 — VQGAN renders these dims EXACTLY (stride-16 latents, no engine floor drift)
    expect(autoDims({ width: 1920, height: 1080 }, 512, 16)).toEqual({ width: 688, height: 384 })
  })
  test('portrait 3:4-ish attachment lands near the table pair', () => {
    expect(autoDims({ width: 1500, height: 2000 }, 512, 8)).toEqual({ width: 440, height: 592 })
  })
  test('extreme AR: no clamp, the short dim floors at one multiple', () => {
    expect(autoDims({ width: 8000, height: 100 }, 256, 8)).toEqual({ width: 2288, height: 32 })
    expect(autoDims({ width: 1, height: 512 }, 256, 16)).toEqual({ width: 16, height: 5792 })
  })
  test('degenerate natural dims throw (decode boundary owns rejecting these)', () => {
    expect(() => autoDims({ width: 0, height: 100 }, 512, 8)).toThrow()
  })
})

describe('steps/look tables', () => {
  test('the steps presets are exactly the five spec numbers, in gear order', () => {
    expect([...STEPS_IDS]).toEqual([150, 200, 300, 450, 600])
  })
  test('parseStepsId: exact match on the chip dataset strings, throw on anything else', () => {
    expect(parseStepsId('150')).toBe(150)
    expect(parseStepsId('600')).toBe(600)
    expect(() => parseStepsId('175')).toThrow() // no nearest-neighbor (§5.3 doctrine)
    expect(() => parseStepsId('nope')).toThrow()
  })
  test('image_model strings', () => {
    expect(lookModel('limited')).toBe('Limited Palette')
    expect(lookModel('unlimited')).toBe('Unlimited Palette')
    expect(lookModel('vqgan')).toBe('VQGAN')
  })
})

describe('composeSubmission (fresh)', () => {
  test('overrides-over-defaults: exactly the nine fields, no seed when random', () => {
    const payload = composeSubmission({
      prompt: '  a mushroom forest ',
      aspect: '16:9',
      size: 'full',
      steps: 200,
      look: 'limited',
      seedMode: { kind: 'random' },
      tweak: null,
      init: null,
    })
    expect(payload.values).toEqual({
      scenes: 'a mushroom forest',
      width: 640,
      height: 360,
      steps_per_scene: 200,
      image_model: 'Limited Palette',
      animation_mode: 'off',
      interpolation_steps: 0,
      coarse_to_fine: true,
      coarse_stages: 3,
    })
    expect(payload.forkOf).toBeNull()
    expect(payload.seedLocked).toBe(false)
  })

  test('steps rides verbatim, decoupled from size (600 on draft dims)', () => {
    const payload = composeSubmission({
      prompt: 'x',
      aspect: '1:1',
      size: 'draft',
      steps: 600,
      look: 'limited',
      seedMode: { kind: 'random' },
      tweak: null,
      init: null,
    })
    expect(payload.values['width']).toBe(256)
    expect(payload.values['height']).toBe(256)
    expect(payload.values['steps_per_scene']).toBe(600)
  })

  test('locked seed adds the seed field and seedLocked', () => {
    const payload = composeSubmission({
      prompt: 'x',
      aspect: '1:1',
      size: 'draft',
      steps: 150,
      look: 'vqgan',
      seedMode: { kind: 'locked', seed: 42 },
      tweak: null,
      init: null,
    })
    expect(payload.values['seed']).toBe(42)
    expect(payload.seedLocked).toBe(true)
  })

  test('empty prompt throws (caller must guard)', () => {
    expect(() =>
      composeSubmission({ prompt: '  ', aspect: '1:1', size: 'draft', steps: 150, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null }),
    ).toThrow()
  })

  test('fresh composer with null ids throws (aspect, size, steps each)', () => {
    expect(() =>
      composeSubmission({ prompt: 'x', aspect: null, size: 'draft', steps: 150, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null }),
    ).toThrow()
    expect(() =>
      composeSubmission({ prompt: 'x', aspect: '1:1', size: null, steps: 150, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null }),
    ).toThrow()
    expect(() =>
      composeSubmission({ prompt: 'x', aspect: '1:1', size: 'draft', steps: null, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null }),
    ).toThrow()
  })
})

describe('composeSubmission (tweak)', () => {
  const base = { scenes: 'old prompt', width: 448, height: 576, steps_per_scene: 200, image_model: 'Limited Palette', seed: 7, cutouts: 16 }

  test('null chips inherit the base; prompt always overrides; random seed is REMOVED', () => {
    const payload = composeSubmission({
      prompt: 'new prompt',
      aspect: null,
      size: null,
      steps: null,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's-0001-x', baseValues: { ...base } },
      init: null,
    })
    expect(payload.values).toEqual({ scenes: 'new prompt', width: 448, height: 576, steps_per_scene: 200, image_model: 'Limited Palette', cutouts: 16 })
    expect(payload.forkOf).toBe('s-0001-x')
    expect(payload.seedLocked).toBe(false)
  })

  test('concrete chips override; locked seed pins', () => {
    const payload = composeSubmission({
      prompt: 'new prompt',
      aspect: '16:9',
      size: 'full',
      steps: 300,
      look: 'vqgan',
      seedMode: { kind: 'locked', seed: 7 },
      tweak: { of: 's-0001-x', baseValues: { ...base } },
      init: null,
    })
    expect(payload.values['width']).toBe(640)
    expect(payload.values['height']).toBe(360)
    expect(payload.values['steps_per_scene']).toBe(300)
    expect(payload.values['image_model']).toBe('VQGAN')
    expect(payload.values['seed']).toBe(7)
  })

  test('steps overrides alone: dims stay inherited (CUSTOM aspect/size untouched)', () => {
    const payload = composeSubmission({
      prompt: 'p',
      aspect: null,
      size: null,
      steps: 450,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 999, height: 333, steps_per_scene: 200 } },
      init: null,
    })
    expect(payload.values['width']).toBe(999)
    expect(payload.values['height']).toBe(333)
    expect(payload.values['steps_per_scene']).toBe(450)
  })

  test('base steps inherit verbatim while steps is CUSTOM, even with concrete dims chips', () => {
    const payload = composeSubmission({
      prompt: 'p',
      aspect: '16:9',
      size: 'full',
      steps: null,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 999, height: 333, steps_per_scene: 275 } },
      init: null,
    })
    expect(payload.values['width']).toBe(640)
    expect(payload.values['height']).toBe(360)
    expect(payload.values['steps_per_scene']).toBe(275)
  })

  test('aspect override with CUSTOM size inherits the base size class (256)', () => {
    const payload = composeSubmission({
      prompt: 'p',
      aspect: '16:9',
      size: null,
      steps: null,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 224, height: 288 } },
      init: null,
    })
    expect(payload.values['width']).toBe(320)
    expect(payload.values['height']).toBe(180)
  })

  test('aspect override over a non-preset base falls to the 512 class', () => {
    const payload = composeSubmission({
      prompt: 'p',
      aspect: '1:1',
      size: null,
      steps: null,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 999, height: 333 } },
      init: null,
    })
    expect(payload.values['width']).toBe(512)
    expect(payload.values['height']).toBe(512)
  })
})

describe('composerDims', () => {
  test('fresh: table lookup', () => {
    expect(
      composerDims({ prompt: 'p', aspect: '16:9', size: 'draft', steps: 150, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null }),
    ).toEqual({ width: 320, height: 180 })
  })
  test('tweak with CUSTOM aspect inherits base dims', () => {
    expect(
      composerDims({ prompt: 'p', aspect: null, size: null, steps: null, look: null, seedMode: { kind: 'random' }, tweak: { of: "s", baseValues: { width: 640, height: 360 } }, init: null }),
    ).toEqual({ width: 640, height: 360 })
  })
  test('tweak without numeric base dims falls to 512x512', () => {
    expect(
      composerDims({ prompt: 'p', aspect: null, size: null, steps: null, look: null, seedMode: { kind: 'random' }, tweak: { of: "s", baseValues: {} }, init: null }),
    ).toEqual({ width: 512, height: 512 })
  })
  test('AUTO matches what composeSubmission emits (optimistic tile AR = session AR)', () => {
    const input = {
      prompt: 'p',
      aspect: 'auto' as const,
      size: 'full' as const,
      steps: 200 as const,
      look: 'limited' as const,
      seedMode: { kind: 'random' as const },
      tweak: null,
      init: { path: '/up/a.png', natural: { width: 1920, height: 1080 }, strength: 'medium' as const, holdMeaning: false, mask: null },
    }
    const dims = composerDims(input)
    expect(dims).toEqual({ width: 680, height: 384 })
    const payload = composeSubmission(input)
    expect(payload.values['width']).toBe(dims.width)
    expect(payload.values['height']).toBe(dims.height)
  })
})

describe('AUTO aspect through composeSubmission (§5.1a)', () => {
  const freshAuto = (look: 'limited' | 'unlimited' | 'vqgan', natural: { width: number; height: number } | null) => ({
    prompt: 'p',
    aspect: 'auto' as const,
    size: 'full' as const,
    steps: 200 as const,
    look,
    seedMode: { kind: 'random' as const },
    tweak: null,
    init: { path: '/up/a.png', natural, strength: 'medium' as const, holdMeaning: false, mask: null },
  })

  test('fresh: rounding multiple follows the LOOK — 8 for the pixel models, 16 for VQGAN', () => {
    expect(composeSubmission(freshAuto('limited', { width: 1920, height: 1080 })).values['width']).toBe(680)
    expect(composeSubmission(freshAuto('unlimited', { width: 1920, height: 1080 })).values['width']).toBe(680)
    expect(composeSubmission(freshAuto('vqgan', { width: 1920, height: 1080 })).values['width']).toBe(688)
  })

  test('fresh without attachment dims throws (chip is disabled until they are known)', () => {
    expect(() => composeSubmission(freshAuto('limited', null))).toThrow()
    expect(() =>
      composeSubmission({ ...freshAuto('limited', null), init: null }),
    ).toThrow()
  })

  test('tweak: AUTO overrides the base dims; the size class comes from the base like any aspect', () => {
    // base dims in the 256 table -> draft budget; base look Limited -> multiple 8
    const payload = composeSubmission({
      prompt: 'p',
      aspect: 'auto',
      size: null,
      steps: null,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 224, height: 288, image_model: 'Limited Palette' } },
      init: { path: '/up/a.png', natural: { width: 1000, height: 1000 }, strength: null, holdMeaning: false, mask: null },
    })
    expect(payload.values['width']).toBe(256)
    expect(payload.values['height']).toBe(256)
  })

  test('tweak with CUSTOM look reads the base image_model for the multiple (VQGAN base -> 16)', () => {
    const payload = composeSubmission({
      prompt: 'p',
      aspect: 'auto',
      size: 'full',
      steps: null,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 512, height: 512, image_model: 'VQGAN' } },
      init: { path: '/up/a.png', natural: { width: 1920, height: 1080 }, strength: null, holdMeaning: false, mask: null },
    })
    expect(payload.values['width']).toBe(688)
    expect(payload.values['height']).toBe(384)
  })
})

describe('matchPresets (exact-match only)', () => {
  test('full match, 512 class -> size full', () => {
    expect(matchPresets({ width: 640, height: 360, steps_per_scene: 200, image_model: 'Limited Palette' })).toEqual({
      aspect: '16:9',
      size: 'full',
      steps: 200,
      look: 'limited',
    })
  })
  test('full match, 256 class -> size draft', () => {
    expect(matchPresets({ width: 256, height: 256, steps_per_scene: 150, image_model: 'VQGAN' })).toEqual({
      aspect: '1:1',
      size: 'draft',
      steps: 150,
      look: 'vqgan',
    })
  })
  test('steps is decoupled from the dims class: 150 on 512-class dims stays concrete', () => {
    // Under the retired quality preset this combination forced CUSTOM; the split
    // controls each rematerialize on their own exact match.
    expect(matchPresets({ width: 512, height: 512, steps_per_scene: 150, image_model: 'Limited Palette' })).toEqual({
      aspect: '1:1',
      size: 'full',
      steps: 150,
      look: 'limited',
    })
  })
  test('steps matches even when the dims miss (aspect + size null together)', () => {
    expect(matchPresets({ width: 500, height: 500, steps_per_scene: 450, image_model: 'nope' })).toEqual({
      aspect: null,
      size: null,
      steps: 450,
      look: null,
    })
  })
  test('any miss -> null for that control, no nearest-neighbor', () => {
    expect(matchPresets({ width: 500, height: 500, steps_per_scene: 275, image_model: 'nope' })).toEqual({
      aspect: null,
      size: null,
      steps: null, // 275 is between presets — CUSTOM, never rounded to 300
      look: null,
    })
  })
  test('non-numeric dims -> nulls', () => {
    expect(matchPresets({ width: '512', height: 512 }).aspect).toBeNull()
    expect(matchPresets({ width: '512', height: 512 }).size).toBeNull()
  })
  test("AUTO never rematerializes: auto-computed dims off the tables come back CUSTOM (§5.3)", () => {
    // 680x384 is exactly what AUTO emits for a 1920x1080 attachment at full/limited,
    // but the snapshot carries no attachment dims to decide that by — not cleanly
    // decidable, so no guessing: CUSTOM inherits the base dims verbatim instead.
    expect(matchPresets({ width: 680, height: 384, steps_per_scene: 200, image_model: 'Limited Palette' })).toEqual({
      aspect: null,
      size: null,
      steps: 200,
      look: 'limited',
    })
    // A square attachment's AUTO dims ARE a table pair — that exact match is cleanly
    // decidable and rematerializes as the equivalent 1:1 chip (same dims either way).
    expect(matchPresets({ width: 512, height: 512 }).aspect).toBe('1:1')
  })
})

describe('submittableValues', () => {
  test('keeps only whitelisted keys', () => {
    expect(submittableValues({ scenes: 'p', seed: 1, _private: true, config_version: 3 }, ['scenes', 'seed', 'width'])).toEqual({
      scenes: 'p',
      seed: 1,
    })
  })
})

test('fresh composeSubmission pins animation_mode off (stills surface)', () => {
  const payload = composeSubmission({
    prompt: 'x',
    aspect: '1:1',
    size: 'draft',
    steps: 150,
    look: 'limited',
    seedMode: { kind: 'random' },
    tweak: null,
    init: null,
  })
  expect(payload.values['animation_mode']).toBe('off')
})

describe('composeSubmission init — fresh (§15.6)', () => {
  const fresh = {
    prompt: 'p',
    aspect: '1:1' as const,
    size: 'draft' as const,
    steps: 150 as const,
    look: 'limited' as const,
    seedMode: { kind: 'random' as const },
    tweak: null,
  }

  test('attached at medium, no mask, hold off: init_image + "4", no semantic/backend keys', () => {
    const payload = composeSubmission({
      ...fresh,
      init: { path: '/up/a.png', natural: null, strength: 'medium', holdMeaning: false, mask: null },
    })
    expect(payload.values['init_image']).toBe('/up/a.png')
    expect(payload.values['direct_init_weight']).toBe('4')
    expect('semantic_init_weight' in payload.values).toBe(false)
    expect('perceptor_backend' in payload.values).toBe(false)
  })

  test('subtle / strong map to 1.5 / 10', () => {
    expect(
      composeSubmission({ ...fresh, init: { path: '/up/a.png', natural: null, strength: 'subtle', holdMeaning: false, mask: null } })
        .values['direct_init_weight'],
    ).toBe('1.5')
    expect(
      composeSubmission({ ...fresh, init: { path: '/up/a.png', natural: null, strength: 'strong', holdMeaning: false, mask: null } })
        .values['direct_init_weight'],
    ).toBe('10')
  })

  test('mask rides in the bracket; inverted puts the - inside it', () => {
    expect(
      composeSubmission({
        ...fresh,
        init: { path: '/up/a.png', natural: null, strength: 'medium', holdMeaning: false, mask: { path: '/up/m.png', inverted: false } },
      }).values['direct_init_weight'],
    ).toBe('4_[/up/m.png]')
    expect(
      composeSubmission({
        ...fresh,
        init: { path: '/up/a.png', natural: null, strength: 'medium', holdMeaning: false, mask: { path: '/up/m.png', inverted: true } },
      }).values['direct_init_weight'],
    ).toBe('4_[-/up/m.png]')
  })

  test('hold meaning pins semantic 0.3 AND the torch backend', () => {
    const payload = composeSubmission({
      ...fresh,
      init: { path: '/up/a.png', natural: null, strength: 'medium', holdMeaning: true, mask: null },
    })
    expect(payload.values['semantic_init_weight']).toBe('4')
    expect(payload.values['perceptor_backend']).toBe('torch')
  })

  test('no attachment: none of the four keys appear (ruling 5 — absent, never empty strings)', () => {
    const payload = composeSubmission({ ...fresh, init: null })
    for (const key of ['init_image', 'direct_init_weight', 'semantic_init_weight', 'perceptor_backend']) {
      expect(key in payload.values).toBe(false)
    }
  })

  test('fresh init with null strength throws (unreachable per bar-clear rule)', () => {
    expect(() =>
      composeSubmission({ ...fresh, init: { path: '/up/a.png', natural: null, strength: null, holdMeaning: false, mask: null } }),
    ).toThrow()
  })
})

describe('composeSubmission init — tweak (§15.6, override only on diff)', () => {
  const tweakInput = (
    baseValues: Record<string, unknown>,
    init: Parameters<typeof composeSubmission>[0]['init'],
  ): Parameters<typeof composeSubmission>[0] => ({
    prompt: 'p',
    aspect: null,
    size: null,
    steps: null,
    look: null,
    seedMode: { kind: 'random' },
    tweak: { of: 's-1', baseValues },
    init,
  })

  test('chip removed: the three init keys are deleted; perceptor_backend is left alone', () => {
    const payload = composeSubmission(
      tweakInput(
        {
          init_image: '/up/a.png',
          direct_init_weight: '4',
          semantic_init_weight: '0.5',
          perceptor_backend: 'torch',
          width: 512,
        },
        null,
      ),
    )
    expect('init_image' in payload.values).toBe(false)
    expect('direct_init_weight' in payload.values).toBe(false)
    expect('semantic_init_weight' in payload.values).toBe(false)
    expect(payload.values['perceptor_backend']).toBe('torch')
  })

  test('untouched OPAQUE base weight rides verbatim (cutoffs survive)', () => {
    const base = { init_image: '/x/a.png', direct_init_weight: '1_r_0.3' }
    const payload = composeSubmission(tweakInput(base, { path: '/x/a.png', natural: null, strength: null, holdMeaning: false, mask: null }))
    expect(payload.values['direct_init_weight']).toBe('1_r_0.3')
  })

  test('untouched simple base with mask rides verbatim (no recompose)', () => {
    const base = { init_image: '/up/a.png', direct_init_weight: '0.45_[/up/m.png]' }
    const payload = composeSubmission(
      tweakInput(base, {
        path: '/up/a.png',
        natural: null,
        strength: null,
        holdMeaning: false,
        mask: { path: '/up/m.png', inverted: false },
      }),
    )
    expect(payload.values['direct_init_weight']).toBe('0.45_[/up/m.png]')
  })

  test('picking a strength recomposes and drops an opaque tail', () => {
    const base = { init_image: '/x/a.png', direct_init_weight: '1_r_0.3' }
    const payload = composeSubmission(tweakInput(base, { path: '/x/a.png', natural: null, strength: 'strong', holdMeaning: false, mask: null }))
    expect(payload.values['direct_init_weight']).toBe('10')
  })

  test('mask change over a simple base with CUSTOM strength keeps the base weight expr', () => {
    const base = { init_image: '/up/a.png', direct_init_weight: '0.45' }
    const payload = composeSubmission(
      tweakInput(base, {
        path: '/up/a.png',
        natural: null,
        strength: null,
        holdMeaning: false,
        mask: { path: '/up/new.png', inverted: true },
      }),
    )
    expect(payload.values['direct_init_weight']).toBe('0.45_[-/up/new.png]')
  })

  test('mask change over a NON-simple base with CUSTOM strength throws (locked by construction)', () => {
    const base = { init_image: '/x/a.png', direct_init_weight: '1_r_0.3' }
    expect(() =>
      composeSubmission(
        tweakInput(base, {
          path: '/x/a.png',
          natural: null,
          strength: null,
          holdMeaning: false,
          mask: { path: '/up/m.png', inverted: false },
        }),
      ),
    ).toThrow()
  })

  test('init_image always rides (replaced image on an untouched weight)', () => {
    const base = { init_image: '/up/old.png', direct_init_weight: '0.45' }
    const payload = composeSubmission(tweakInput(base, { path: '/up/new.png', natural: null, strength: null, holdMeaning: false, mask: null }))
    expect(payload.values['init_image']).toBe('/up/new.png')
    expect(payload.values['direct_init_weight']).toBe('0.45')
  })

  test('semantic: matching toggle -> a non-0.3 base value rides verbatim, backend pinned', () => {
    const base = { init_image: '/up/a.png', direct_init_weight: '4', semantic_init_weight: '0.7' }
    const payload = composeSubmission(tweakInput(base, { path: '/up/a.png', natural: null, strength: null, holdMeaning: true, mask: null }))
    expect(payload.values['semantic_init_weight']).toBe('0.7')
    expect(payload.values['perceptor_backend']).toBe('torch') // unconditional while on
  })

  test('semantic toggled ON over an off base -> 0.3 + torch', () => {
    const base = { init_image: '/up/a.png', direct_init_weight: '4', semantic_init_weight: '' }
    const payload = composeSubmission(tweakInput(base, { path: '/up/a.png', natural: null, strength: null, holdMeaning: true, mask: null }))
    expect(payload.values['semantic_init_weight']).toBe('4')
    expect(payload.values['perceptor_backend']).toBe('torch')
  })

  test('semantic toggled OFF over an on base -> key deleted, backend untouched', () => {
    const base = {
      init_image: '/up/a.png',
      direct_init_weight: '4',
      semantic_init_weight: '0.7',
      perceptor_backend: 'torch',
    }
    const payload = composeSubmission(tweakInput(base, { path: '/up/a.png', natural: null, strength: null, holdMeaning: false, mask: null }))
    expect('semantic_init_weight' in payload.values).toBe(false)
    expect(payload.values['perceptor_backend']).toBe('torch')
  })
})


test('fresh composeSubmission with HOLD MEANING omits coarse_to_fine (engine refuses the pair)', () => {
  const payload = composeSubmission({
    prompt: 'x',
    aspect: '1:1',
    size: 'draft',
    steps: 150,
    look: 'limited',
    seedMode: { kind: 'random' },
    tweak: null,
    init: {
      path: '/up/a.png',
      natural: null,
      strength: 'medium',
      holdMeaning: true,
      mask: null,
    },
  })
  expect('coarse_to_fine' in payload.values).toBe(false)
  expect(payload.values['perceptor_backend']).toBe('torch')
})

// ── The isolation invariant (spec §5.6) ──────────────────────────────────────
// "There can be no hidden sticky state or anything like that for features I
//  can't see on the UI. It needs to be completely separate from the advanced
//  mode." Every key a submission carries must be a visible control, a documented
// pin, or (tweak only) a key of the fork base's own snapshot. Walked over the
// full composer-option product so a new composeSubmission key cannot land
// undocumented.
describe('isolation invariant: submissions are reconstructible from what the user sees', () => {
  const SEED_MODES = [{ kind: 'random' as const }, { kind: 'locked' as const, seed: 7 }]
  const INITS: Parameters<typeof composeSubmission>[0]['init'][] = [
    null,
    { path: '/up/a.png', natural: null, strength: 'subtle', holdMeaning: false, mask: null },
    { path: '/up/a.png', natural: { width: 1920, height: 1080 }, strength: 'medium', holdMeaning: false, mask: { path: '/up/m.png', inverted: true } },
    { path: '/up/a.png', natural: { width: 800, height: 2000 }, strength: 'strong', holdMeaning: true, mask: null },
  ]

  test('fresh: payload keys ⊆ visible controls ∪ documented pins', () => {
    // AUTO joins the walk (§5.1a): it is an aspect VALUE — width/height stay determined
    // by visible controls (the chip + the visible attachment; SIZE still picks the
    // budget). It only pairs with attachments whose dims are known — elsewhere the
    // chip is disabled, so those combinations are unreachable by construction.
    const aspects = [...ASPECT_IDS, 'auto' as const]
    const violations: string[] = []
    for (const aspect of aspects) {
      for (const size of SIZE_IDS) {
        for (const steps of STEPS_IDS) {
          for (const look of LOOK_IDS) {
            for (const seedMode of SEED_MODES) {
              for (const init of INITS) {
                if (aspect === 'auto' && (init == null || init.natural == null)) continue
                const payload = composeSubmission({ prompt: 'p', aspect, size, steps, look, seedMode, tweak: null, init })
                for (const key of Object.keys(payload.values)) {
                  if (!VISIBLE_CONTROL_FIELDS.includes(key) && !PIN_FIELDS.includes(key)) {
                    violations.push(`${aspect}/${size}/${steps}/${look}/${seedMode.kind}/${init == null ? 'no-init' : 'init'}: ${key}`)
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('auto+attachment: exactly the computed dims land in values — nothing else changes (§5.6)', () => {
    const init = {
      path: '/up/a.png',
      natural: { width: 1920, height: 1080 },
      strength: 'medium' as const,
      holdMeaning: false,
      mask: null,
    }
    const at = (aspect: '1:1' | 'auto') =>
      composeSubmission({ prompt: 'p', aspect, size: 'full', steps: 200, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init })
    const table = at('1:1')
    const auto = at('auto')
    expect(auto.values['width']).toBe(680) // autoDims(1920x1080, 512-class, ÷8)
    expect(auto.values['height']).toBe(384)
    expect(Object.keys(auto.values).sort()).toEqual(Object.keys(table.values).sort())
    for (const key of Object.keys(table.values)) {
      if (key !== 'width' && key !== 'height') expect(auto.values[key]).toEqual(table.values[key])
    }
    expect(auto.forkOf).toBe(table.forkOf)
    expect(auto.seedLocked).toBe(table.seedLocked)
  })

  test('tweak: payload keys ⊆ the fork base snapshot ∪ visible controls ∪ pins', () => {
    // A realistic base: the fork snapshot is complete (every schema field), so
    // stand-in extras represent the fields Create has no controls for.
    const base = {
      scenes: 'old', width: 512, height: 512, steps_per_scene: 200, image_model: 'Limited Palette',
      seed: 3, cutouts: 40, smoothing_weight: 1, direct_stabilization_weight: '1',
      init_image: '/up/a.png', direct_init_weight: '4', semantic_init_weight: '',
    }
    const violations: string[] = []
    for (const seedMode of SEED_MODES) {
      for (const init of INITS) {
        const payload = composeSubmission({
          prompt: 'new', aspect: '16:9', size: 'full', steps: 300, look: 'vqgan', seedMode,
          tweak: { of: 's-1', baseValues: { ...base } }, init,
        })
        for (const key of Object.keys(payload.values)) {
          if (!(key in base) && !VISIBLE_CONTROL_FIELDS.includes(key) && !PIN_FIELDS.includes(key)) {
            violations.push(`${seedMode.kind}/${init == null ? 'no-init' : 'init'}: ${key}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})
