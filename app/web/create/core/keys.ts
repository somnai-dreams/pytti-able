// @cs
// create/core/keys: KeyFacts -> Intent, the whole keyboard map (spec §9.2) as one pure
// function. The dom layer builds the facts from the event and guards intent SCOPE
// (frame-prev/next and job-prev/next only act while the lightbox is open); the mapping
// itself is scope-free. No other bindings exist.
//
// String domain (key names) — outside freerange's numeric subset; keys.test.ts is the
// checked surface.
//
//   KeyFacts = { key, meta, ctrl, inInput }   meta = Cmd; ctrl for non-Mac parity
//   Intent = 'submit' | 'rerun-last' | 'dismiss' | 'focus-prompt'
//          | 'frame-prev' | 'frame-next' | 'job-prev' | 'job-next' | 'none'
//   keyIntent(facts) -> Intent
// @/cs

export type KeyFacts = { key: string; meta: boolean; ctrl: boolean; inInput: boolean }

export type Intent =
  | 'submit'
  | 'rerun-last'
  | 'dismiss'
  | 'focus-prompt'
  | 'frame-prev'
  | 'frame-next'
  | 'job-prev'
  | 'job-next'
  | 'none'

export function keyIntent(facts: KeyFacts): Intent {
  switch (facts.key) {
    case 'Enter':
      if (facts.meta || facts.ctrl) return 'rerun-last' // global
      return facts.inInput ? 'submit' : 'none' // bar focused only
    case 'Escape':
      return 'dismiss' // topmost surface; else blur bar
    case '/':
      return facts.inInput ? 'none' : 'focus-prompt'
    case 'ArrowLeft':
      return facts.inInput ? 'none' : 'frame-prev'
    case 'ArrowRight':
      return facts.inInput ? 'none' : 'frame-next'
    case 'ArrowUp':
      return facts.inInput ? 'none' : 'job-prev'
    case 'ArrowDown':
      return facts.inInput ? 'none' : 'job-next'
    default:
      return 'none'
  }
}
