# Vendored kit/

These modules are copied VERBATIM from mj-gallery's `kit/` systems library
(branch `systems-library` @ `e3f96e3174`; pin also recorded in the staging
area's `KIT_COMMIT` at vendoring time) — the kit is copy-portable by design
(no imports outside itself; see each module's README and `@cs` file headers).
This app consumes it exactly the way a fresh codebase is meant to: copy the
module, read the `@cs` header, call the functions via the `@kit/*` alias.

Rules:

1. **Don't edit these files in place.** Fixes belong upstream in the kit; sync
   by re-copying and bumping the commit hash above. App-specific policy
   (sizes, timings, thresholds) lives at the call site or in a local config
   object, never inside a module — that's the kit's own geometry-vs-policy
   rule (`feel.ts` files hold the source app's presets; this app may pass its
   own numbers).
2. Modules vendored here: `midui` (scalar/Vec2 kernel + spring/scheduler +
   rAF dom layer), `env` (environment snapshot read once at the boundary),
   `onestore` (single-store render-loop chassis), `toplayer`
   (floating-UI-as-data placement + Z-ladder), `interaction` (pill/tooltip
   state machines + cluster geometry), `masonry` (packing walk + culling +
   scroll-anchor math), `reel-strip` (film-strip navigation + wheel-swipe
   machine). `*.test.ts` files are each module's checked surface; `kit.test.ts`
   mechanically enforces the no-`src/`-imports and core-layering rules. Run
   with `bun test kit` from `app/web/`.
3. Deliberately NOT vendored: react layer files, `examples/`, and the
   `chip-query`, `history-tree`, `versioned-store`, `virtual-grid` modules —
   this app doesn't need them; cores are pure TS and bun bundles them
   untouched.
4. Edits made during vendoring: **none** — every file is byte-identical to the
   source commit (`kit.test.ts` roots its import-graph walk at
   `import.meta.dir`, so no path fix was needed).
