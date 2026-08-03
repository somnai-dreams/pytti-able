# @kit/onestore

The single-store render-loop chassis — the doctrine this app runs on ("one plain
state object; event functions mutate it and call scheduleRender; each frame renders
the latest state once; no per-key subscriptions, no memo graphs") as runnable
machinery. Extracted from the production-proven primitives: `useDedupedRender`'s
id-tracked cancellable rAF dedupe and `ClientPointerContext`'s snapshot store.

- `core.ts` — `makeRenderLoop(render, frames, now)` with an injected `FrameSource`
  (browser-free, tests pump frames by hand) and `createSnapshotChannel<T>` for
  per-frame input that must never schedule a render.
- `dom.ts` — `rafRenderLoop(render)`: the rAF + `performance.now()` binding.
- `createWakeLoop(step, frames, now, timers)` — the deadline-driven controller
  skeleton (the pill recheck pattern): invalidations coalesce to one step per
  frame; the step returns the next absolute deadline or null and the loop arms
  a timer to invalidate itself then. Machines return deadlines as data instead
  of scattering setTimeouts.

**The controlled-input decision** (phase-2 open question, resolved here):
`renderNow()`. A controlled text field must reflect the keystroke in the same task
or the caret jumps — React papers over this with a silent synchronous flush for
discrete events; here it's an explicit call the input's event handler makes,
cancelling any pending frame so nothing double-renders. Everything that isn't
keystroke echo uses `scheduleRender()`.

**Deliberately not a framework.** There is no `createStore`, no state container
type, no dispatch: the store is a plain object you compose in dependency order
(the app's `AppProvider` shape), events are named functions that mutate it, and
derived values are computed during render — recompute over cache, per
`docs/engineering.md`. The chassis example (`kit/examples/`, phase-2 A5) is the
worked composition; copying a framework would just re-prescribe the shapes
vibescript warns about.

Loop-domain state (mutable ids/flags) is outside freerange's subset; the test
suite is this module's checked surface (dedupe, cancel-on-renderNow, re-entrancy
throw, mid-publish unsubscribe safety).
