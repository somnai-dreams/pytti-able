# Follow-ups from the annotations.yaml audit

Findings from writing `app/annotations.yaml` (the three-way diff between
`pytti-core/src/pytti/config/structured_config.py`, the old `app/ui.py`
docs, and `docs/studio-spec.md` §4). Nothing here blocks the annotations
file — it's written, parses, and covers all 79 schema fields. These are
the drift, gaps, and traps found along the way, ordered by when to act.

## 1. Design gaps — close before the frontend hardcodes around them

- [ ] **Extend the `relevantWhen` predicate with a non-empty form.**
  The current shape (`{field, in: [...]}`) can only express membership.
  Three real dependencies are inexpressible and currently live only in
  hint text:
  - `breath_mode`, `direct_init_weight`, `semantic_init_weight` → require
    non-empty `init_image`
  - `input_audio_offset`, `input_audio_filters` → require non-empty
    `input_audio`
  - `interpolation_steps` → requires `||` in `scenes`

  The bench widgets make some of these structurally impossible (spec puts
  `breath_mode` physically inside the init drop-well), but the engine room
  renders every field, so it needs the predicate. Suggested: allow a
  second form like `relevantWhen: {nonEmpty: init_image}` in
  `annotations.yaml` and teach `/api/schema` + the engine-room renderer to
  evaluate it. Cheap now; special-cases in the frontend later.

- [ ] **Session YAML writer must serialize via `yaml.dump`, never string
  templates.** YAML 1.1 footgun: unquoted `animation_mode: off` parses as
  boolean `False` under pyyaml/omegaconf. `yaml.dump` quotes it correctly.
  One guard or comment at the single serialization point in the server.

## 2. Doc rot in `app/ui.py` — dies with the studio migration, verify it dies

The spec deletes `load_existing()` fallbacks and makes annotations.yaml +
schema introspection the only doc/default source. When the gradio UI is
retired (or before, if it lingers), these known-wrong bits go with it:

- [ ] **Wrong `t` definition** — TIPS says "t (frame number)"
  (`app/ui.py:61` and the other motion tips). Actual semantics:
  t = seconds of animation time (frames elapsed ÷ frames_per_second).
  Anyone writing `10*sin(t/30)` off the old tooltip gets motion 12× faster
  than expected at default fps. annotations.yaml carries the correct
  definition everywhere.
- [ ] **Stale defaults in HELP_SECTIONS** vs schema: `cut_pow` "Default: 1"
  vs schema 2; `interpolation_steps` "Default: 200" vs 0;
  `flow_long_term_samples` "Default: 0" vs 1; `pre_animation_steps`
  "250 / 50" split. annotations.yaml states no defaults at all — the
  server merges them from the schema, so they can't drift again.
- [ ] **Dropdown fallbacks are a third default source** contradicting the
  schema (`app/ui.py:937-939`): `image_model` falls back to
  "Limited Palette" vs schema "Unlimited Palette"; `vqgan_model` "coco"
  vs "sflickr"; `animation_mode` "3D" vs "off". Spec §4 already sentences
  these to deletion.
- [ ] Once `/api/schema` serves merged docs, **delete TIPS/HELP_SECTIONS
  outright** (or generate them from annotations.yaml if ui.py must
  survive a while). Two doc sources already drifted; don't run three.

## 3. pytti-core schema changes — want Max's sign-off (not studio-side)

- [ ] **`save_every` default 50 → 0.** The schema comment says 0 =
  auto-match `steps_per_frame`, which is both the recommended setting and
  what the studio sends. The current default of 50 only works because it
  coincidentally equals `steps_per_frame`'s default — change one, forget
  the other, and saved frames desync from animation frames. Making 0 the
  default removes the trap. Pre-user, so no compat concern, but it's a
  core change.
- [ ] **`display_every` same shape** — spec has the server set it equal to
  the effective save cadence anyway; a 0-means-auto convention (or just
  letting the server always pin it) removes another magic 50.
- [ ] **`AudioFilterConfig` uses `-1` sentinels** for `f_center`/`f_width`
  instead of `Optional` (`structured_config.py:32-36`). Minor
  type-discipline nit, but the spec exposes the filter table in the UI
  for the first time, so "is -1 unset or a value?" becomes a real UI
  question. Prefer `float | None`.

## 4. `/api/preflight` backlog — checks core doesn't do

- [ ] **`steps_per_scene >= interpolation_steps`.** Docs claim it, core
  never validates it — `workhorse.py` passes `interp_steps` straight
  through to `run_steps` (~`workhorse.py:436-450`). Preflight is the
  spec's single correctness authority; this belongs there.

## 5. Verified non-issues — don't re-investigate

- **`gradient_accumulation_steps` must divide `cutouts`** is already
  fail-loud at startup (`pytti-core/src/pytti/workhorse.py:197-201`).
  The engine room's live validation is UX on top of a real boundary
  check, not the only line of defense.
- **`pixel_size` feeds all three image models** (PixelImage scale,
  RGBImage, VQGANImage — `workhorse.py:249-284`). The spec's placement on
  the LP card with force-to-1 under VQGAN is a design choice, not a code
  mismatch. annotations.yaml leaves it ungated.
- **`smoothing_weight` is a global TV loss**
  (`LossAug/LossOrchestratorClass.py:145-146`), not Limited-Palette-only
  as the old help grouping implied. Ungated in annotations.yaml.
