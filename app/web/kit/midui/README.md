# @kit/midui

The scalar/2D geometry + motion kernel. This is the reunified canonical copy of a
file that had drifted into three variants: `src/MidUI/MidUI.ts` (the 2023 original,
freerange-hardened in production) and vibescript's `todos/midui.ts` +
`todos/_gonggong-test/MidUI.ts` (which kept the shadertoy hashes, Vec types,
overlap-area, and `spring`'s explicit destination parameter that the app copy
dropped). Everything else in the kit builds on these primitives.

- `num.ts` — core. Vec2/3/4, Rect, clamp/remap/remapReverso/mix/fract/easings,
  center/fit/length, inclusive point/rect predicates, overlapArea, minIndex/
  argMinRounded, rem, hash11/21/31. Pure, freerange-analyzable (divisor spans are
  named before checking).
- `motion.ts` — core, with a flagged exception: `springStep`/`springGoToEnd`
  mutate their `Spring` (deliberate hot-loop choice, outside the freerange
  subset). `springStepCount` is the checked spiral-of-death guard; the file
  header documents the fixed-timestep frame-loop pattern.
- `dom.ts` — `makeScheduler`, the rAF-coalesced render loop. Browser-only, hence
  not in core.

App migration status: COMPLETE — `src/MidUI/MidUI.ts` is deleted; all 42 former
importers use this module (`XY` became `Vec2`; `MIN_WINDOW_SIZE_X/Y` rehomed to
`src/MidUI/NewSidebarLayout.ts` as the app token it always was).
Do not add app design tokens (breakpoints, max widths) to this module — those
belong to the app's layout layer.
