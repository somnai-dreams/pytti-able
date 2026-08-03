# @kit/env

The environment snapshot: every fact about the browser environment worth reading —
viewport size, pointer capability (fine/touch), reduced motion, safe-area insets —
parsed ONCE at the boundary and passed everywhere as plain data. This is the
design-out for render-time device probes, scattered `matchMedia` calls, and the
N-sources-of-truth viewport pattern.

`core.ts` is the data: the `Env` type, `defaultEnv()` (neutral desktop assumption
for tests — real bindings replace it on first watch), and `parseCssPx` (strict:
`''` → 0 because an absent CSS var means no inset; a px-suffixed decimal parses;
anything else throws). `dom.ts` is the ONE place the browser is read: `readEnv()`,
`watchEnv(onChange)` (a single listener set — window resize + three matchMedia
listeners — each event re-reads the full snapshot), and the shared `FINE_POINTER`
media query so other dom layers use the exact same capability probe.

Safe-area contract: CSS `env()` is only readable through custom properties, so the
host page declares the four `--kit-safe-area-*` vars once in global CSS (spelled
out in the `dom.ts` header). Absent vars read as 0; malformed values throw.

Freerange: 1/2 (pinned) — `defaultEnv` analyzes at 0 findings; `parseCssPx` is
string domain (parse-at-boundary regex), covered by `core.test.ts`.

Consumers: `kit/interaction/dom.ts` (shares `FINE_POINTER`) and the
`chassis-notes` example (env → store → render loop). The app itself still reads
viewport/pointer facts through its legacy paths — adopting this module app-side is
future work.
