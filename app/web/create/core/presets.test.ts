import { describe, expect, test } from 'bun:test'
import {
  ASPECT_IDS,
  autoDims,
  composeSubmission,
  composerDims,
  DEFAULT_STEPS,
  defaultExperiments,
  type Experiments,
  LOOK_IDS,
  lookModel,
  matchExperiments,
  matchPresets,
  MAX_CUSTOM_STEPS,
  parseCustomSteps,
  parseStepsId,
  PIN_FIELDS,
  rematerializeSteps,
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
  test('the steps presets are exactly the six spec numbers, in gear order (§5.1)', () => {
    expect([...STEPS_IDS]).toEqual([150, 200, 300, 600, 1200, 2400])
  })
  test('parseStepsId: exact match on the chip dataset strings, throw on anything else', () => {
    expect(parseStepsId('150')).toBe(150)
    expect(parseStepsId('2400')).toBe(2400)
    expect(() => parseStepsId('450')).toThrow() // retired preset — no longer chip markup
    expect(() => parseStepsId('175')).toThrow() // no nearest-neighbor (§5.3 doctrine)
    expect(() => parseStepsId('nope')).toThrow()
  })
  test('image_model strings', () => {
    expect(lookModel('limited')).toBe('Limited Palette')
    expect(lookModel('unlimited')).toBe('Unlimited Palette')
    expect(lookModel('vqgan')).toBe('VQGAN')
  })
})

describe('parseCustomSteps (the gear input boundary — recoverable data, never a throw)', () => {
  test('plain positive integers in range parse, whitespace tolerated', () => {
    expect(parseCustomSteps('275')).toBe(275)
    expect(parseCustomSteps('1')).toBe(1)
    expect(parseCustomSteps(' 7500 ')).toBe(7500)
    expect(parseCustomSteps(String(MAX_CUSTOM_STEPS))).toBe(20000)
  })
  test('out of range, non-integer, signed, and junk are null', () => {
    expect(parseCustomSteps('0')).toBeNull()
    expect(parseCustomSteps('20001')).toBeNull()
    expect(parseCustomSteps('2.5')).toBeNull()
    expect(parseCustomSteps('-5')).toBeNull()
    expect(parseCustomSteps('+5')).toBeNull()
    expect(parseCustomSteps('1e3')).toBeNull()
    expect(parseCustomSteps('')).toBeNull()
    expect(parseCustomSteps('abc')).toBeNull()
  })
})

describe('rematerializeSteps (§5.3 — always concrete, no null-inherit)', () => {
  test('the base steps_per_scene rides verbatim, preset or not', () => {
    expect(rematerializeSteps({ steps_per_scene: 200 })).toBe(200)
    expect(rematerializeSteps({ steps_per_scene: 275 })).toBe(275)
    // beyond the INPUT cap: a bench-authored count still rematerializes verbatim
    expect(rematerializeSteps({ steps_per_scene: 50000 })).toBe(50000)
  })
  test('missing or unusable base values fall to DEFAULT_STEPS, shown concretely', () => {
    expect(rematerializeSteps({})).toBe(DEFAULT_STEPS)
    expect(rematerializeSteps({ steps_per_scene: '275' })).toBe(DEFAULT_STEPS)
    expect(rematerializeSteps({ steps_per_scene: 0 })).toBe(DEFAULT_STEPS)
    expect(rematerializeSteps({ steps_per_scene: 2.5 })).toBe(DEFAULT_STEPS)
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
      experiments: defaultExperiments(),
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

  test('steps rides verbatim, decoupled from size (2400 on draft dims)', () => {
    const payload = composeSubmission({
      prompt: 'x',
      aspect: '1:1',
      size: 'draft',
      steps: 2400,
      look: 'limited',
      seedMode: { kind: 'random' },
      tweak: null,
      init: null,
      experiments: defaultExperiments(),
    })
    expect(payload.values['width']).toBe(256)
    expect(payload.values['height']).toBe(256)
    expect(payload.values['steps_per_scene']).toBe(2400)
  })

  test('a custom (non-preset) steps value rides verbatim too', () => {
    const payload = composeSubmission({
      prompt: 'x',
      aspect: '1:1',
      size: 'full',
      steps: 275,
      look: 'limited',
      seedMode: { kind: 'random' },
      tweak: null,
      init: null,
      experiments: defaultExperiments(),
    })
    expect(payload.values['steps_per_scene']).toBe(275)
  })

  test('non-positive-integer steps throws (the boundaries guarantee validity)', () => {
    const fresh = { prompt: 'x', aspect: '1:1' as const, size: 'full' as const, look: 'limited' as const, seedMode: { kind: 'random' as const }, tweak: null, init: null, experiments: defaultExperiments() }
    expect(() => composeSubmission({ ...fresh, steps: 0 })).toThrow()
    expect(() => composeSubmission({ ...fresh, steps: 2.5 })).toThrow()
    expect(() => composeSubmission({ ...fresh, steps: -100 })).toThrow()
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
      experiments: defaultExperiments(),
    })
    expect(payload.values['seed']).toBe(42)
    expect(payload.seedLocked).toBe(true)
  })

  test('empty prompt throws (caller must guard)', () => {
    expect(() =>
      composeSubmission({ prompt: '  ', aspect: '1:1', size: 'draft', steps: 150, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null, experiments: defaultExperiments() }),
    ).toThrow()
  })

  test('fresh composer with null ids throws (aspect, size each — steps admits no null)', () => {
    expect(() =>
      composeSubmission({ prompt: 'x', aspect: null, size: 'draft', steps: 150, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null, experiments: defaultExperiments() }),
    ).toThrow()
    expect(() =>
      composeSubmission({ prompt: 'x', aspect: '1:1', size: null, steps: 150, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null, experiments: defaultExperiments() }),
    ).toThrow()
  })

  test('fresh composer with a null experiment row throws (null = tweak-only CUSTOM, §5.7)', () => {
    for (const row of ['noise', 'pyramid', 'coherence', 'fullVision', 'phase', 'autoStop'] as const) {
      expect(() =>
        composeSubmission({
          prompt: 'x',
          aspect: '1:1',
          size: 'draft',
          steps: 150,
          look: 'limited',
          seedMode: { kind: 'random' },
          tweak: null,
          init: null,
          experiments: { ...defaultExperiments(), [row]: null },
        }),
      ).toThrow()
    }
  })
})

describe('composeSubmission (tweak)', () => {
  const base = { scenes: 'old prompt', width: 448, height: 576, steps_per_scene: 200, image_model: 'Limited Palette', seed: 7, cutouts: 16 }

  test('null chips inherit the base; prompt always overrides; random seed is REMOVED', () => {
    const payload = composeSubmission({
      prompt: 'new prompt',
      aspect: null,
      size: null,
      steps: rematerializeSteps(base), // what tweakSession materializes — the base's 200
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's-0001-x', baseValues: { ...base } },
      init: null,
      experiments: matchExperiments(base), // what tweakSession materializes (§5.7) — all rows at the base
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
      experiments: matchExperiments(base),
    })
    expect(payload.values['width']).toBe(640)
    expect(payload.values['height']).toBe(360)
    expect(payload.values['steps_per_scene']).toBe(300)
    expect(payload.values['image_model']).toBe('VQGAN')
    expect(payload.values['seed']).toBe(7)
  })

  test('steps overrides alone (a custom 450): dims stay inherited (CUSTOM aspect/size untouched)', () => {
    const payload = composeSubmission({
      prompt: 'p',
      aspect: null,
      size: null,
      steps: 450,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 999, height: 333, steps_per_scene: 200 } },
      init: null,
      experiments: matchExperiments({ width: 999, height: 333, steps_per_scene: 200 }),
    })
    expect(payload.values['width']).toBe(999)
    expect(payload.values['height']).toBe(333)
    expect(payload.values['steps_per_scene']).toBe(450)
  })

  test('an untouched tweak submits the rematerialized base steps verbatim, even with concrete dims chips', () => {
    const baseValues = { width: 999, height: 333, steps_per_scene: 275 }
    const payload = composeSubmission({
      prompt: 'p',
      aspect: '16:9',
      size: 'full',
      steps: rematerializeSteps(baseValues), // 275, shown in the custom input
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues },
      init: null,
      experiments: matchExperiments(baseValues),
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
      steps: 200,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 224, height: 288 } },
      init: null,
      experiments: matchExperiments({ width: 224, height: 288 }),
    })
    expect(payload.values['width']).toBe(320)
    expect(payload.values['height']).toBe(180)
  })

  test('aspect override over a non-preset base falls to the 512 class', () => {
    const payload = composeSubmission({
      prompt: 'p',
      aspect: '1:1',
      size: null,
      steps: 200,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 999, height: 333 } },
      init: null,
      experiments: matchExperiments({ width: 999, height: 333 }),
    })
    expect(payload.values['width']).toBe(512)
    expect(payload.values['height']).toBe(512)
  })
})

describe('composerDims', () => {
  test('fresh: table lookup', () => {
    expect(
      composerDims({ prompt: 'p', aspect: '16:9', size: 'draft', steps: 150, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null, experiments: defaultExperiments() }),
    ).toEqual({ width: 320, height: 180 })
  })
  test('tweak with CUSTOM aspect inherits base dims', () => {
    expect(
      composerDims({ prompt: 'p', aspect: null, size: null, steps: 200, look: null, seedMode: { kind: 'random' }, tweak: { of: "s", baseValues: { width: 640, height: 360 } }, init: null, experiments: defaultExperiments() }),
    ).toEqual({ width: 640, height: 360 })
  })
  test('tweak without numeric base dims falls to 512x512', () => {
    expect(
      composerDims({ prompt: 'p', aspect: null, size: null, steps: 200, look: null, seedMode: { kind: 'random' }, tweak: { of: "s", baseValues: {} }, init: null, experiments: defaultExperiments() }),
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
      experiments: defaultExperiments(),
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
    experiments: defaultExperiments(),
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
      steps: 200,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 224, height: 288, image_model: 'Limited Palette' } },
      init: { path: '/up/a.png', natural: { width: 1000, height: 1000 }, strength: null, holdMeaning: false, mask: null },
      experiments: matchExperiments({ width: 224, height: 288, image_model: 'Limited Palette' }),
    })
    expect(payload.values['width']).toBe(256)
    expect(payload.values['height']).toBe(256)
  })

  test('tweak with CUSTOM look reads the base image_model for the multiple (VQGAN base -> 16)', () => {
    const payload = composeSubmission({
      prompt: 'p',
      aspect: 'auto',
      size: 'full',
      steps: 200,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 512, height: 512, image_model: 'VQGAN' } },
      init: { path: '/up/a.png', natural: { width: 1920, height: 1080 }, strength: null, holdMeaning: false, mask: null },
      experiments: matchExperiments({ width: 512, height: 512, image_model: 'VQGAN' }),
    })
    expect(payload.values['width']).toBe(688)
    expect(payload.values['height']).toBe(384)
  })
})

describe('matchPresets (exact-match only; steps is NOT preset-matched — §5.3)', () => {
  test('full match, 512 class -> size full', () => {
    expect(matchPresets({ width: 640, height: 360, steps_per_scene: 200, image_model: 'Limited Palette' })).toEqual({
      aspect: '16:9',
      size: 'full',
      look: 'limited',
    })
  })
  test('full match, 256 class -> size draft', () => {
    expect(matchPresets({ width: 256, height: 256, steps_per_scene: 150, image_model: 'VQGAN' })).toEqual({
      aspect: '1:1',
      size: 'draft',
      look: 'vqgan',
    })
  })
  test('any miss -> null for that control, no nearest-neighbor', () => {
    expect(matchPresets({ width: 500, height: 500, image_model: 'nope' })).toEqual({
      aspect: null,
      size: null,
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
    experiments: defaultExperiments(),
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
    experiments: defaultExperiments(),
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
      // HOLD on rides with PYRAMID OFF — applyHoldMeaning forces the pair (§5.7).
      experiments: { ...defaultExperiments(), pyramid: 'off' },
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
  ): Parameters<typeof composeSubmission>[0] => {
    // Mirror tweakSession exactly (§5.7): rematerialize the panel from the base, then
    // re-assert the pyramid × HOLD rule (HOLD on => PYRAMID off).
    const experiments = matchExperiments(baseValues)
    if (init != null && init.holdMeaning) experiments.pyramid = 'off'
    return {
      prompt: 'p',
      aspect: null,
      size: null,
      steps: 200,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's-1', baseValues },
      init,
      experiments,
    }
  }

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


describe('pyramid × HOLD MEANING (§5.7 — the engine refuses c2f + semantic init)', () => {
  const holdInit = {
    path: '/up/a.png',
    natural: null,
    strength: 'medium' as const,
    holdMeaning: true,
    mask: null,
  }

  test('HOLD with PYRAMID OFF (what applyHoldMeaning forces) omits the c2f keys, pins torch', () => {
    const payload = composeSubmission({
      prompt: 'x',
      aspect: '1:1',
      size: 'draft',
      steps: 150,
      look: 'limited',
      seedMode: { kind: 'random' },
      tweak: null,
      init: holdInit,
      experiments: { ...defaultExperiments(), pyramid: 'off' },
    })
    expect('coarse_to_fine' in payload.values).toBe(false)
    expect('coarse_stages' in payload.values).toBe(false)
    expect(payload.values['perceptor_backend']).toBe('torch')
  })

  test('HOLD with a non-OFF pyramid row THROWS — never a silent omission (fresh and tweak)', () => {
    expect(() =>
      composeSubmission({
        prompt: 'x',
        aspect: '1:1',
        size: 'draft',
        steps: 150,
        look: 'limited',
        seedMode: { kind: 'random' },
        tweak: null,
        init: holdInit,
        experiments: defaultExperiments(), // pyramid '3' — applyHoldMeaning must have forced 'off'
      }),
    ).toThrow()
    expect(() =>
      composeSubmission({
        prompt: 'x',
        aspect: null,
        size: null,
        steps: 150,
        look: null,
        seedMode: { kind: 'random' },
        tweak: { of: 's-1', baseValues: { init_image: '/up/a.png', direct_init_weight: '4' } },
        init: holdInit,
        // null (CUSTOM) would let base c2f keys ride under HOLD — equally rejected.
        experiments: { ...matchExperiments({}), pyramid: null },
      }),
    ).toThrow()
  })
})

// ── The EXPERIMENTS panel (spec §5.7) ─────────────────────────────────────────
describe('experiments — fresh emission and the payload rule (§5.7)', () => {
  const freshWith = (experiments: Experiments) =>
    composeSubmission({
      prompt: 'p',
      aspect: '1:1',
      size: 'full',
      steps: 200,
      look: 'limited',
      seedMode: { kind: 'random' },
      tweak: null,
      init: null,
      experiments,
    })

  test('the untouched panel is byte-identical to the pre-panel payload (the retired pin, verbatim)', () => {
    const payload = freshWith(defaultExperiments())
    expect(payload.values).toEqual({
      scenes: 'p',
      width: 512,
      height: 512,
      steps_per_scene: 200,
      image_model: 'Limited Palette',
      animation_mode: 'off',
      interpolation_steps: 0,
      coarse_to_fine: true, // PYRAMID 3 — the judged pin, now the visible default
      coarse_stages: 3,
    })
  })

  test('the payload rule: each non-default selection adds exactly its own keys', () => {
    const baseline = Object.keys(freshWith(defaultExperiments()).values).sort()
    const added = (experiments: Experiments): string[] =>
      Object.keys(freshWith(experiments).values)
        .filter((k) => !baseline.includes(k))
        .sort()
    // Defaults add ZERO keys beyond the baseline; each flip adds only its row's fields.
    expect(added(defaultExperiments())).toEqual([])
    expect(added({ ...defaultExperiments(), noise: 'pink' })).toEqual(['init_spectrum', 'init_spectrum_chroma'])
    expect(added({ ...defaultExperiments(), noise: 'gray' })).toEqual(['init_spectrum'])
    expect(added({ ...defaultExperiments(), coherence: 'on' })).toEqual(['coherence_weighting'])
    expect(added({ ...defaultExperiments(), fullVision: 'on' })).toEqual(['cutout_sampler'])
    expect(added({ ...defaultExperiments(), phase: 'on' })).toEqual(['phase_scheduling'])
    expect(added({ ...defaultExperiments(), autoStop: 'on' })).toEqual(['auto_stop'])
    // PYRAMID inverts: OFF (the engine default) REMOVES the pin pair from the baseline.
    const offKeys = Object.keys(freshWith({ ...defaultExperiments(), pyramid: 'off' }).values).sort()
    expect(offKeys).toEqual(baseline.filter((k) => k !== 'coarse_to_fine' && k !== 'coarse_stages'))
  })

  test('INIT NOISE: PINK pairs chroma natural (the battery winner); GRAY emits spectrum only; WHITE nothing', () => {
    const pink = freshWith({ ...defaultExperiments(), noise: 'pink' }).values
    expect(pink['init_spectrum']).toBe('pink')
    expect(pink['init_spectrum_chroma']).toBe('natural')
    const gray = freshWith({ ...defaultExperiments(), noise: 'gray' }).values
    expect(gray['init_spectrum']).toBe('gray')
    expect('init_spectrum_chroma' in gray).toBe(false)
    const white = freshWith(defaultExperiments()).values
    expect('init_spectrum' in white).toBe(false)
    expect('init_spectrum_chroma' in white).toBe(false)
  })

  test('PYRAMID 2/3/4 emit the pair; OFF emits neither key', () => {
    for (const pyramid of ['2', '3', '4'] as const) {
      const values = freshWith({ ...defaultExperiments(), pyramid }).values
      expect(values['coarse_to_fine']).toBe(true)
      expect(values['coarse_stages']).toBe(Number(pyramid))
    }
    const off = freshWith({ ...defaultExperiments(), pyramid: 'off' }).values
    expect('coarse_to_fine' in off).toBe(false)
    expect('coarse_stages' in off).toBe(false)
  })

  test('toggles: ON emits the true/full value; OFF emits NOTHING (never an explicit smart/false)', () => {
    const on = freshWith({ ...defaultExperiments(), coherence: 'on', fullVision: 'on', phase: 'on', autoStop: 'on' }).values
    expect(on['coherence_weighting']).toBe(true)
    expect(on['cutout_sampler']).toBe('full')
    expect(on['phase_scheduling']).toBe(true)
    expect(on['auto_stop']).toBe(true)
    const off = freshWith(defaultExperiments()).values
    for (const key of ['coherence_weighting', 'cutout_sampler', 'phase_scheduling', 'auto_stop']) {
      expect(key in off).toBe(false)
    }
  })
})

describe('matchExperiments (§5.3 doctrine — exact-match only, misses are CUSTOM)', () => {
  test('an empty/schema-default base rematerializes WHITE + OFF everywhere except the pyramid (engine-default OFF)', () => {
    expect(matchExperiments({})).toEqual({
      noise: 'white',
      pyramid: 'off',
      coherence: 'off',
      fullVision: 'off',
      phase: 'off',
      autoStop: 'off',
    })
  })

  test('a Create-authored panel round-trips through its own submission values', () => {
    const picks: Experiments = { noise: 'pink', pyramid: '4', coherence: 'on', fullVision: 'on', phase: 'on', autoStop: 'on' }
    const payload = composeSubmission({
      prompt: 'p', aspect: '1:1', size: 'full', steps: 200, look: 'limited',
      seedMode: { kind: 'random' }, tweak: null, init: null, experiments: picks,
    })
    expect(matchExperiments(payload.values)).toEqual(picks)
  })

  test('noise: pink needs chroma natural; any other pink chroma is CUSTOM; chroma is ignored for white/gray (engine-inert)', () => {
    expect(matchExperiments({ init_spectrum: 'pink', init_spectrum_chroma: 'natural' }).noise).toBe('pink')
    expect(matchExperiments({ init_spectrum: 'pink', init_spectrum_chroma: 'full' }).noise).toBeNull()
    expect(matchExperiments({ init_spectrum: 'pink' }).noise).toBeNull() // absent chroma composes 'full'
    expect(matchExperiments({ init_spectrum: 'fractal' }).noise).toBeNull() // battery loser — bench-only
    expect(matchExperiments({ init_spectrum: 'white', init_spectrum_chroma: 'mono' }).noise).toBe('white')
    expect(matchExperiments({ init_spectrum: 'gray', init_spectrum_chroma: 'natural' }).noise).toBe('gray')
    expect(matchExperiments({ init_spectrum: 7 }).noise).toBeNull()
  })

  test('pyramid: stages 2/3/4 with c2f true; coarse_stages 5 is CUSTOM; c2f false/absent is OFF', () => {
    expect(matchExperiments({ coarse_to_fine: true, coarse_stages: 3 }).pyramid).toBe('3')
    expect(matchExperiments({ coarse_to_fine: true, coarse_stages: 2 }).pyramid).toBe('2')
    expect(matchExperiments({ coarse_to_fine: true, coarse_stages: 4 }).pyramid).toBe('4')
    expect(matchExperiments({ coarse_to_fine: true, coarse_stages: 5 }).pyramid).toBeNull()
    expect(matchExperiments({ coarse_to_fine: true }).pyramid).toBeNull() // no ladder in the snapshot
    expect(matchExperiments({ coarse_to_fine: false }).pyramid).toBe('off')
    expect(matchExperiments({ coarse_to_fine: 'yes' }).pyramid).toBeNull()
  })

  test('toggles: true/false/absent map ON/OFF/OFF; junk is CUSTOM; cutout_sampler smart IS the row OFF', () => {
    expect(matchExperiments({ coherence_weighting: true }).coherence).toBe('on')
    expect(matchExperiments({ coherence_weighting: false }).coherence).toBe('off')
    expect(matchExperiments({ coherence_weighting: 'yes' }).coherence).toBeNull()
    expect(matchExperiments({ cutout_sampler: 'smart' }).fullVision).toBe('off')
    expect(matchExperiments({ cutout_sampler: 'full' }).fullVision).toBe('on')
    expect(matchExperiments({ cutout_sampler: 'classic' }).fullVision).toBeNull() // rides verbatim
    expect(matchExperiments({ phase_scheduling: true }).phase).toBe('on')
    expect(matchExperiments({ auto_stop: true }).autoStop).toBe('on')
  })
})

describe('experiments — tweak semantics (§5.7: concrete applies, CUSTOM inherits verbatim)', () => {
  const tweakWith = (baseValues: Record<string, unknown>, experiments: Experiments) =>
    composeSubmission({
      prompt: 'p',
      aspect: null,
      size: null,
      steps: 200,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's-1', baseValues },
      init: null,
      experiments,
    })

  test('null (CUSTOM) rows leave off-menu base values untouched — byte-for-byte', () => {
    const base = {
      width: 512, height: 512,
      init_spectrum: 'fractal', init_spectrum_chroma: 'mono', init_spectrum_falloff: 2.5,
      coarse_to_fine: true, coarse_stages: 5,
      cutout_sampler: 'classic', coherence_weighting: 'junk',
    }
    const allCustom: Experiments = { noise: null, pyramid: null, coherence: null, fullVision: null, phase: null, autoStop: null }
    const values = tweakWith(base, allCustom).values
    expect(values['init_spectrum']).toBe('fractal')
    expect(values['init_spectrum_chroma']).toBe('mono')
    expect(values['init_spectrum_falloff']).toBe(2.5)
    expect(values['coarse_to_fine']).toBe(true)
    expect(values['coarse_stages']).toBe(5)
    expect(values['cutout_sampler']).toBe('classic')
    expect(values['coherence_weighting']).toBe('junk')
  })

  test('an untouched rematerialized panel replays the base exactly (rematerialize -> compose round-trip)', () => {
    const base = {
      width: 512, height: 512, steps_per_scene: 200,
      init_spectrum: 'pink', init_spectrum_chroma: 'natural',
      coarse_to_fine: true, coarse_stages: 3,
      coherence_weighting: true, cutout_sampler: 'full', phase_scheduling: false, auto_stop: false,
    }
    const values = tweakWith(base, matchExperiments(base)).values
    // Non-default rows re-apply the base's own values verbatim…
    expect(values['init_spectrum']).toBe('pink')
    expect(values['init_spectrum_chroma']).toBe('natural')
    expect(values['coarse_to_fine']).toBe(true)
    expect(values['coarse_stages']).toBe(3)
    expect(values['coherence_weighting']).toBe(true)
    expect(values['cutout_sampler']).toBe('full')
    // …and rows rematerialized OFF delete the base's explicit-default keys — the
    // server's defaults-compose restores the same false values, so the COMPOSED
    // config is identical (the §5.3 replay claim; wire keys may differ).
    expect('phase_scheduling' in values).toBe(false)
    expect('auto_stop' in values).toBe(false)
  })

  test('a concrete re-pick DELETES the row fields the selection does not carry (restores the composed default)', () => {
    const base = {
      init_spectrum: 'pink', init_spectrum_chroma: 'natural', init_spectrum_falloff: 2.5,
      coarse_to_fine: true, coarse_stages: 5,
      cutout_sampler: 'classic', coherence_weighting: true, phase_scheduling: true, auto_stop: true,
    }
    const values = tweakWith(base, defaultExperiments()).values // WHITE / 3 / off / off / off / off
    expect('init_spectrum' in values).toBe(false) // WHITE = the composed default
    expect('init_spectrum_chroma' in values).toBe(false)
    expect(values['init_spectrum_falloff']).toBe(2.5) // the bench knob is NOT the row's field — rides
    expect(values['coarse_to_fine']).toBe(true)
    expect(values['coarse_stages']).toBe(3) // the off-menu 5 re-picked as 3
    expect('cutout_sampler' in values).toBe(false) // OFF deletes — composes 'smart'
    expect('coherence_weighting' in values).toBe(false)
    expect('phase_scheduling' in values).toBe(false)
    expect('auto_stop' in values).toBe(false)
  })

  test('flipping rows ON over a bare base emits exactly the row values', () => {
    const values = tweakWith({ width: 512 }, { noise: 'gray', pyramid: 'off', coherence: 'on', fullVision: 'on', phase: 'on', autoStop: 'on' }).values
    expect(values['init_spectrum']).toBe('gray')
    expect('coarse_to_fine' in values).toBe(false)
    expect(values['coherence_weighting']).toBe(true)
    expect(values['cutout_sampler']).toBe('full')
    expect(values['phase_scheduling']).toBe(true)
    expect(values['auto_stop']).toBe(true)
  })
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
  // The steps axis is no longer a closed set: walk the preset chips PLUS a non-preset
  // custom value (275 — the custom input) and the input's extreme (MAX_CUSTOM_STEPS).
  const STEPS_AXIS: readonly number[] = [...STEPS_IDS, 275, MAX_CUSTOM_STEPS]
  const INITS: Parameters<typeof composeSubmission>[0]['init'][] = [
    null,
    { path: '/up/a.png', natural: null, strength: 'subtle', holdMeaning: false, mask: null },
    { path: '/up/a.png', natural: { width: 1920, height: 1080 }, strength: 'medium', holdMeaning: false, mask: { path: '/up/m.png', inverted: true } },
    { path: '/up/a.png', natural: { width: 800, height: 2000 }, strength: 'strong', holdMeaning: true, mask: null },
  ]
  // The experiments axis (§5.7): every row at default, every row flipped, plus the
  // remaining single-row alternates — each offered option appears in the walk at
  // least once on both the fresh and tweak sides.
  const EXPERIMENTS_AXIS: readonly Experiments[] = [
    defaultExperiments(),
    { noise: 'pink', pyramid: 'off', coherence: 'on', fullVision: 'on', phase: 'on', autoStop: 'on' },
    { ...defaultExperiments(), noise: 'gray', pyramid: '2' },
    { ...defaultExperiments(), pyramid: '4' },
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
        for (const steps of STEPS_AXIS) {
          for (const look of LOOK_IDS) {
            for (const seedMode of SEED_MODES) {
              for (const init of INITS) {
                for (const experiments of EXPERIMENTS_AXIS) {
                  if (aspect === 'auto' && (init == null || init.natural == null)) continue
                  // HOLD forces PYRAMID off in the same transition (applyHoldMeaning) —
                  // other pairings are unreachable by construction and throw.
                  if (init != null && init.holdMeaning && experiments.pyramid !== 'off') continue
                  const payload = composeSubmission({ prompt: 'p', aspect, size, steps, look, seedMode, tweak: null, init, experiments })
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
      composeSubmission({ prompt: 'p', aspect, size: 'full', steps: 200, look: 'limited', seedMode: { kind: 'random' }, tweak: null, init, experiments: defaultExperiments() })
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
    // The tweak side adds the all-CUSTOM panel (every row null — inherit base verbatim)
    // to the §5.7 axis; null rows must contribute NO keys of their own.
    const TWEAK_EXPERIMENTS: readonly Experiments[] = [
      ...EXPERIMENTS_AXIS,
      { noise: null, pyramid: null, coherence: null, fullVision: null, phase: null, autoStop: null },
    ]
    for (const steps of STEPS_AXIS) {
      for (const seedMode of SEED_MODES) {
        for (const init of INITS) {
          for (const experiments of TWEAK_EXPERIMENTS) {
            if (init != null && init.holdMeaning && experiments.pyramid !== 'off') continue // §5.7, as fresh
            const payload = composeSubmission({
              prompt: 'new', aspect: '16:9', size: 'full', steps, look: 'vqgan', seedMode,
              tweak: { of: 's-1', baseValues: { ...base } }, init, experiments,
            })
            for (const key of Object.keys(payload.values)) {
              if (!(key in base) && !VISIBLE_CONTROL_FIELDS.includes(key) && !PIN_FIELDS.includes(key)) {
                violations.push(`${steps}/${seedMode.kind}/${init == null ? 'no-init' : 'init'}: ${key}`)
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})
