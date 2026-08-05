import { describe, expect, test } from 'bun:test'
import {
  composeDraft,
  composerDims,
  draftableValues,
  lookModel,
  matchPresets,
  qualitySteps,
  resolveDims,
} from './presets'

describe('resolveDims', () => {
  test('the exact table (spec §5.1)', () => {
    expect(resolveDims('1:1', 'draft')).toEqual({ width: 256, height: 256 })
    expect(resolveDims('3:4', 'draft')).toEqual({ width: 224, height: 288 })
    expect(resolveDims('4:3', 'draft')).toEqual({ width: 288, height: 224 })
    expect(resolveDims('16:9', 'draft')).toEqual({ width: 320, height: 180 })
    expect(resolveDims('1:1', 'standard')).toEqual({ width: 512, height: 512 })
    expect(resolveDims('3:4', 'standard')).toEqual({ width: 448, height: 576 })
    expect(resolveDims('4:3', 'deep')).toEqual({ width: 576, height: 448 })
    expect(resolveDims('16:9', 'deep')).toEqual({ width: 640, height: 360 })
  })
})

describe('quality/look tables', () => {
  test('steps', () => {
    expect(qualitySteps('draft')).toBe(150)
    expect(qualitySteps('standard')).toBe(200)
    expect(qualitySteps('deep')).toBe(300)
  })
  test('image_model strings', () => {
    expect(lookModel('limited')).toBe('Limited Palette')
    expect(lookModel('unlimited')).toBe('Unlimited Palette')
    expect(lookModel('vqgan')).toBe('VQGAN')
  })
})

describe('composeDraft (fresh)', () => {
  test('overrides-over-defaults: exactly the seven fields, no seed when random', () => {
    const payload = composeDraft({
      prompt: '  a mushroom forest ',
      aspect: '16:9',
      quality: 'standard',
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
    })
    expect(payload.forkOf).toBeNull()
    expect(payload.seedLocked).toBe(false)
  })

  test('locked seed adds the seed field and seedLocked', () => {
    const payload = composeDraft({
      prompt: 'x',
      aspect: '1:1',
      quality: 'draft',
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
      composeDraft({ prompt: '  ', aspect: '1:1', quality: 'draft', look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null }),
    ).toThrow()
  })

  test('fresh composer with null ids throws', () => {
    expect(() =>
      composeDraft({ prompt: 'x', aspect: null, quality: 'draft', look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null }),
    ).toThrow()
  })
})

describe('composeDraft (tweak)', () => {
  const base = { scenes: 'old prompt', width: 448, height: 576, steps_per_scene: 200, image_model: 'Limited Palette', seed: 7, cutouts: 16 }

  test('null chips inherit the base; prompt always overrides; random seed is REMOVED', () => {
    const payload = composeDraft({
      prompt: 'new prompt',
      aspect: null,
      quality: null,
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
    const payload = composeDraft({
      prompt: 'new prompt',
      aspect: '16:9',
      quality: 'deep',
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

  test('aspect override with CUSTOM quality inherits the base size class (256)', () => {
    const payload = composeDraft({
      prompt: 'p',
      aspect: '16:9',
      quality: null,
      look: null,
      seedMode: { kind: 'random' },
      tweak: { of: 's', baseValues: { width: 224, height: 288 } },
      init: null,
    })
    expect(payload.values['width']).toBe(320)
    expect(payload.values['height']).toBe(180)
  })

  test('aspect override over a non-preset base falls to the 512 class', () => {
    const payload = composeDraft({
      prompt: 'p',
      aspect: '1:1',
      quality: null,
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
      composerDims({ prompt: 'p', aspect: '16:9', quality: 'draft', look: 'limited', seedMode: { kind: 'random' }, tweak: null, init: null }),
    ).toEqual({ width: 320, height: 180 })
  })
  test('tweak with CUSTOM aspect inherits base dims', () => {
    expect(
      composerDims({ prompt: 'p', aspect: null, quality: null, look: null, seedMode: { kind: 'random' }, tweak: { of: "s", baseValues: { width: 640, height: 360 } }, init: null }),
    ).toEqual({ width: 640, height: 360 })
  })
  test('tweak without numeric base dims falls to 512x512', () => {
    expect(
      composerDims({ prompt: 'p', aspect: null, quality: null, look: null, seedMode: { kind: 'random' }, tweak: { of: "s", baseValues: {} }, init: null }),
    ).toEqual({ width: 512, height: 512 })
  })
})

describe('matchPresets (exact-match only)', () => {
  test('full match, 512 class', () => {
    expect(matchPresets({ width: 640, height: 360, steps_per_scene: 200, image_model: 'Limited Palette' })).toEqual({
      aspect: '16:9',
      quality: 'standard',
      look: 'limited',
    })
  })
  test('full match, 256 class -> draft only', () => {
    expect(matchPresets({ width: 256, height: 256, steps_per_scene: 150, image_model: 'VQGAN' })).toEqual({
      aspect: '1:1',
      quality: 'draft',
      look: 'vqgan',
    })
  })
  test('steps matching but class mismatching -> quality null', () => {
    // 150 steps is draft (256 class) but the dims are 512-class
    expect(matchPresets({ width: 512, height: 512, steps_per_scene: 150, image_model: 'Limited Palette' }).quality).toBeNull()
  })
  test('any miss -> null for that control, no nearest-neighbor', () => {
    expect(matchPresets({ width: 500, height: 500, steps_per_scene: 200, image_model: 'nope' })).toEqual({
      aspect: null,
      quality: null, // no dims class to anchor to
      look: null,
    })
  })
  test('non-numeric dims -> nulls', () => {
    expect(matchPresets({ width: '512', height: 512 }).aspect).toBeNull()
  })
})

describe('draftableValues', () => {
  test('keeps only whitelisted keys', () => {
    expect(draftableValues({ scenes: 'p', seed: 1, _private: true, config_version: 3 }, ['scenes', 'seed', 'width'])).toEqual({
      scenes: 'p',
      seed: 1,
    })
  })
})

test('fresh composeDraft pins animation_mode off (stills surface)', () => {
  const payload = composeDraft({
    prompt: 'x',
    aspect: '1:1',
    quality: 'draft',
    look: 'limited',
    seedMode: { kind: 'random' },
    tweak: null,
    init: null,
  })
  expect(payload.values['animation_mode']).toBe('off')
})

describe('composeDraft init — fresh (§15.6)', () => {
  const fresh = {
    prompt: 'p',
    aspect: '1:1' as const,
    quality: 'draft' as const,
    look: 'limited' as const,
    seedMode: { kind: 'random' as const },
    tweak: null,
  }

  test('attached at medium, no mask, hold off: init_image + "4", no semantic/backend keys', () => {
    const payload = composeDraft({
      ...fresh,
      init: { path: '/up/a.png', strength: 'medium', holdMeaning: false, mask: null },
    })
    expect(payload.values['init_image']).toBe('/up/a.png')
    expect(payload.values['direct_init_weight']).toBe('4')
    expect('semantic_init_weight' in payload.values).toBe(false)
    expect('perceptor_backend' in payload.values).toBe(false)
  })

  test('subtle / strong map to 1.5 / 10', () => {
    expect(
      composeDraft({ ...fresh, init: { path: '/up/a.png', strength: 'subtle', holdMeaning: false, mask: null } })
        .values['direct_init_weight'],
    ).toBe('1.5')
    expect(
      composeDraft({ ...fresh, init: { path: '/up/a.png', strength: 'strong', holdMeaning: false, mask: null } })
        .values['direct_init_weight'],
    ).toBe('10')
  })

  test('mask rides in the bracket; inverted puts the - inside it', () => {
    expect(
      composeDraft({
        ...fresh,
        init: { path: '/up/a.png', strength: 'medium', holdMeaning: false, mask: { path: '/up/m.png', inverted: false } },
      }).values['direct_init_weight'],
    ).toBe('4_[/up/m.png]')
    expect(
      composeDraft({
        ...fresh,
        init: { path: '/up/a.png', strength: 'medium', holdMeaning: false, mask: { path: '/up/m.png', inverted: true } },
      }).values['direct_init_weight'],
    ).toBe('4_[-/up/m.png]')
  })

  test('hold meaning pins semantic 0.3 AND the torch backend', () => {
    const payload = composeDraft({
      ...fresh,
      init: { path: '/up/a.png', strength: 'medium', holdMeaning: true, mask: null },
    })
    expect(payload.values['semantic_init_weight']).toBe('4')
    expect(payload.values['perceptor_backend']).toBe('torch')
  })

  test('no attachment: none of the four keys appear (ruling 5 — absent, never empty strings)', () => {
    const payload = composeDraft({ ...fresh, init: null })
    for (const key of ['init_image', 'direct_init_weight', 'semantic_init_weight', 'perceptor_backend']) {
      expect(key in payload.values).toBe(false)
    }
  })

  test('fresh init with null strength throws (unreachable per bar-clear rule)', () => {
    expect(() =>
      composeDraft({ ...fresh, init: { path: '/up/a.png', strength: null, holdMeaning: false, mask: null } }),
    ).toThrow()
  })
})

describe('composeDraft init — tweak (§15.6, override only on diff)', () => {
  const tweakInput = (
    baseValues: Record<string, unknown>,
    init: Parameters<typeof composeDraft>[0]['init'],
  ): Parameters<typeof composeDraft>[0] => ({
    prompt: 'p',
    aspect: null,
    quality: null,
    look: null,
    seedMode: { kind: 'random' },
    tweak: { of: 's-1', baseValues },
    init,
  })

  test('chip removed: the three init keys are deleted; perceptor_backend is left alone', () => {
    const payload = composeDraft(
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
    const payload = composeDraft(tweakInput(base, { path: '/x/a.png', strength: null, holdMeaning: false, mask: null }))
    expect(payload.values['direct_init_weight']).toBe('1_r_0.3')
  })

  test('untouched simple base with mask rides verbatim (no recompose)', () => {
    const base = { init_image: '/up/a.png', direct_init_weight: '0.45_[/up/m.png]' }
    const payload = composeDraft(
      tweakInput(base, {
        path: '/up/a.png',
        strength: null,
        holdMeaning: false,
        mask: { path: '/up/m.png', inverted: false },
      }),
    )
    expect(payload.values['direct_init_weight']).toBe('0.45_[/up/m.png]')
  })

  test('picking a strength recomposes and drops an opaque tail', () => {
    const base = { init_image: '/x/a.png', direct_init_weight: '1_r_0.3' }
    const payload = composeDraft(tweakInput(base, { path: '/x/a.png', strength: 'strong', holdMeaning: false, mask: null }))
    expect(payload.values['direct_init_weight']).toBe('10')
  })

  test('mask change over a simple base with CUSTOM strength keeps the base weight expr', () => {
    const base = { init_image: '/up/a.png', direct_init_weight: '0.45' }
    const payload = composeDraft(
      tweakInput(base, {
        path: '/up/a.png',
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
      composeDraft(
        tweakInput(base, {
          path: '/x/a.png',
          strength: null,
          holdMeaning: false,
          mask: { path: '/up/m.png', inverted: false },
        }),
      ),
    ).toThrow()
  })

  test('init_image always rides (replaced image on an untouched weight)', () => {
    const base = { init_image: '/up/old.png', direct_init_weight: '0.45' }
    const payload = composeDraft(tweakInput(base, { path: '/up/new.png', strength: null, holdMeaning: false, mask: null }))
    expect(payload.values['init_image']).toBe('/up/new.png')
    expect(payload.values['direct_init_weight']).toBe('0.45')
  })

  test('semantic: matching toggle -> a non-0.3 base value rides verbatim, backend pinned', () => {
    const base = { init_image: '/up/a.png', direct_init_weight: '4', semantic_init_weight: '0.7' }
    const payload = composeDraft(tweakInput(base, { path: '/up/a.png', strength: null, holdMeaning: true, mask: null }))
    expect(payload.values['semantic_init_weight']).toBe('0.7')
    expect(payload.values['perceptor_backend']).toBe('torch') // unconditional while on
  })

  test('semantic toggled ON over an off base -> 0.3 + torch', () => {
    const base = { init_image: '/up/a.png', direct_init_weight: '4', semantic_init_weight: '' }
    const payload = composeDraft(tweakInput(base, { path: '/up/a.png', strength: null, holdMeaning: true, mask: null }))
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
    const payload = composeDraft(tweakInput(base, { path: '/up/a.png', strength: null, holdMeaning: false, mask: null }))
    expect('semantic_init_weight' in payload.values).toBe(false)
    expect(payload.values['perceptor_backend']).toBe('torch')
  })
})


test('fresh composeDraft with HOLD MEANING omits coarse_to_fine (engine refuses the pair)', () => {
  const payload = composeDraft({
    prompt: 'x',
    aspect: '1:1',
    quality: 'draft',
    look: 'limited',
    seedMode: { kind: 'random' },
    tweak: null,
    init: {
      path: '/up/a.png',
      strength: 'medium',
      holdMeaning: true,
      mask: null,
    },
  })
  expect('coarse_to_fine' in payload.values).toBe(false)
  expect(payload.values['perceptor_backend']).toBe('torch')
})
