// @cs
// env/dom: the ONE place environment facts are read from the browser.
//
//   readEnv() -> Env
//   watchEnv(onChange) -> dispose
//     one listener set total (window resize + three matchMedia change listeners); each
//     event re-reads the full snapshot and calls onChange(env) — pipe it into your store
//     and scheduleRender.
//
// SAFE-AREA CONTRACT: CSS env() is only readable through custom properties, so the host
// page must declare (once, in global CSS):
//   :root {
//     --kit-safe-area-top: env(safe-area-inset-top);
//     --kit-safe-area-right: env(safe-area-inset-right);
//     --kit-safe-area-bottom: env(safe-area-inset-bottom);
//     --kit-safe-area-left: env(safe-area-inset-left);
//   }
// Absent vars read as 0 (no inset). Malformed values throw (parseCssPx).
// @/cs
import { type Env, parseCssPx, type SafeArea } from './core'

// Exported so other dom layers (e.g. the pointer store) share the exact capability
// probe instead of duplicating the query string.
export const FINE_POINTER = '(hover: hover) and (pointer: fine)'
const COARSE_POINTER = '(pointer: coarse)'
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function readSafeArea(): SafeArea {
  const style = getComputedStyle(document.documentElement)
  return {
    top: parseCssPx(style.getPropertyValue('--kit-safe-area-top')),
    right: parseCssPx(style.getPropertyValue('--kit-safe-area-right')),
    bottom: parseCssPx(style.getPropertyValue('--kit-safe-area-bottom')),
    left: parseCssPx(style.getPropertyValue('--kit-safe-area-left')),
  }
}

export function readEnv(): Env {
  return {
    viewportX: document.documentElement.clientWidth,
    viewportY: document.documentElement.clientHeight,
    pointerFine: window.matchMedia(FINE_POINTER).matches,
    touch: window.matchMedia(COARSE_POINTER).matches,
    reducedMotion: window.matchMedia(REDUCED_MOTION).matches,
    safeArea: readSafeArea(),
  }
}

export function watchEnv(onChange: (env: Env) => void): () => void {
  const notify = () => onChange(readEnv())
  const queries = [FINE_POINTER, COARSE_POINTER, REDUCED_MOTION].map((q) => window.matchMedia(q))
  window.addEventListener('resize', notify)
  for (const query of queries) query.addEventListener('change', notify)
  return () => {
    window.removeEventListener('resize', notify)
    for (const query of queries) query.removeEventListener('change', notify)
  }
}
