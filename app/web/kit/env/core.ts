// @cs
// env/core: the environment snapshot type — every fact about the browser environment the
// app reads, parsed ONCE at the boundary (kit/env/dom.ts) and passed around as plain
// data. Kills render-time device probes and the N-sources-of-truth viewport pattern.
//
// types:
//   SafeArea = { top, right, bottom, left }   px
//   Env = { viewportX, viewportY, pointerFine, touch, reducedMotion, safeArea }
//
// functions:
//   defaultEnv() -> Env      neutral desktop assumption for tests/SSR (1280x800, fine
//                            pointer, no touch, no reduced motion, zero insets); real
//                            bindings replace it with readEnv() on first watch
//   parseCssPx(raw) -> number   '' -> 0 (a CSS var that is ABSENT means no inset — part
//     of the safe-area contract); a px-suffixed decimal ('16px', '16.5px', '-2px') -> the
//     number; ANYTHING else throws — including unitless '16', hex, and exponent forms,
//     which no valid env(safe-area-inset-*) setup produces (fail loud: one
//     interpretation of the var across CSS and JS)
//
// freerange: 1/2 — parseCssPx is string domain (regex parse-at-boundary), outside the
// numeric subset; defaultEnv analyzes at 0 findings. The test suite covers the parser.
// @/cs

export type SafeArea = { top: number, right: number, bottom: number, left: number }

export type Env = {
  viewportX: number
  viewportY: number
  pointerFine: boolean
  touch: boolean
  reducedMotion: boolean
  safeArea: SafeArea
}

export function defaultEnv(): Env {
  return {
    viewportX: 1280,
    viewportY: 800,
    pointerFine: true,
    touch: false,
    reducedMotion: false,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  }
}

const CSS_PX = /^-?(\d+(\.\d+)?|\.\d+)px$/

export function parseCssPx(raw: string): number {
  const trimmed = raw.trim()
  if (trimmed === '') return 0
  if (!CSS_PX.test(trimmed)) throw new Error(`parseCssPx: unparseable CSS length "${raw}"`)
  return Number(trimmed.slice(0, -2))
}
