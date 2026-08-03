// @cs
// onestore/core: the single-store render-loop chassis — the app doctrine ("one plain
// state object; events mutate it and schedule; each frame renders latest state once")
// as runnable machinery. Ported from the production-proven primitives (useDedupedRender's
// id-tracked cancellable dedupe; ClientPointerContext's snapshot store), NOT the dormant
// makeScheduler. Deliberately NOT a framework: state shape and composition stay plain
// code (see README + the chassis example); this module is only the loop and the channels.
//
// types:
//   FrameSource = { request(cb: (now) => void): number, cancel(id): void }
//     injected (rAF in the dom layer) so the core is browser-free and tests pump frames
//   RenderLoop = { scheduleRender(), renderNow(), dispose() }
//   SnapshotChannel<T> = { read(): T, publish(t): void, subscribe(fn): unsubscribe }
//
// functions:
//   makeRenderLoop(render, frames, now) -> RenderLoop
//     scheduleRender: any number of calls before the next frame -> ONE render(now) on it.
//     renderNow: cancel any pending frame and render synchronously. THE controlled-input
//       answer (phase-2 open decision, resolved): a controlled text field must reflect
//       the keystroke within the same task or the caret jumps — React does this silent
//       sync flush for discrete events; here it is an explicit call the input's event
//       handler makes. Everything else uses scheduleRender.
//     Re-entrant renders throw (a render must not render — fail loud).
//     dispose: cancel any pending frame (teardown).
//   createSnapshotChannel(initial) -> SnapshotChannel
//     for per-frame input (pointer position) that must NOT schedule renders: interested
//     parties read() during their own render, or subscribe() for push (the interaction
//     controller pattern). publish never renders anything.
//   createWakeLoop(step, frames, now, timers) -> { invalidate(), dispose() }
//     the deadline-driven controller skeleton (the pill recheck pattern): invalidate()
//     coalesces to one step(now) per frame; step returns the next ABSOLUTE deadline (ms)
//     or null, and the loop arms a timer to invalidate itself then — timing machines
//     return deadlines as data instead of scattering setTimeouts.
//
// freerange: 0/3 — closures over mutable loop state are outside the analyzable subset
// by design (this file IS the mutation boundary); the test suite is the checked surface.
// @/cs

export type FrameSource = {
  request: (cb: (now: number) => void) => number
  cancel: (id: number) => void
}

export type RenderLoop = {
  scheduleRender: () => void
  renderNow: () => void
  dispose: () => void
}

export function makeRenderLoop(
  render: (now: number) => void,
  frames: FrameSource,
  now: () => number,
): RenderLoop {
  let scheduledId: number | null = null
  let rendering = false
  let lastTime = -Infinity

  function runRender(time: number) {
    if (rendering) throw new Error('re-entrant render: a render must not schedule or perform another render synchronously')
    rendering = true
    // Clamp to monotonic: renderNow uses now() while scheduled frames use the rAF frame
    // timestamp (vsync start), which can be EARLIER than a now() taken inside the same
    // task — delivered time never goes backwards.
    const monotonic = time > lastTime ? time : lastTime
    lastTime = monotonic
    try {
      render(monotonic)
    } finally {
      rendering = false
    }
  }

  return {
    scheduleRender: () => {
      if (scheduledId != null) return
      scheduledId = frames.request((time) => {
        scheduledId = null
        runRender(time)
      })
    },
    renderNow: () => {
      if (scheduledId != null) {
        frames.cancel(scheduledId)
        scheduledId = null
      }
      runRender(now())
    },
    dispose: () => {
      if (scheduledId != null) {
        frames.cancel(scheduledId)
        scheduledId = null
      }
    },
  }
}

export type SnapshotChannel<T> = {
  read: () => T
  publish: (t: T) => void
  subscribe: (fn: (t: T) => void) => () => void
}

export function createSnapshotChannel<T>(initial: T): SnapshotChannel<T> {
  let current = initial
  let publishing = false
  let subscribers: ((t: T) => void)[] = []
  return {
    read: () => current,
    publish: (t: T) => {
      if (publishing) {
        // A subscriber publishing during delivery would hand LATER subscribers the older
        // snapshot after their peers saw the newer one — fail loud (same rule as
        // re-entrant render); queue your publish outside the notification instead.
        throw new Error('re-entrant publish: a snapshot subscriber must not publish synchronously')
      }
      current = t
      publishing = true
      try {
        // iterate a snapshot of the list so a subscriber unsubscribing mid-publish
        // (or subscribing) can't skip or double-notify its peers
        const notify = subscribers
        for (const fn of notify) fn(t)
      } finally {
        publishing = false
      }
    },
    subscribe: (fn: (t: T) => void) => {
      subscribers = [...subscribers, fn]
      return () => {
        subscribers = subscribers.filter((s) => s !== fn)
      }
    },
  }
}

export type TimerSource = {
  set: (cb: () => void, ms: number) => number
  clear: (id: number) => void
}

export type WakeLoop = {
  invalidate: () => void
  dispose: () => void
}

export function createWakeLoop(
  step: (now: number) => number | null,
  frames: FrameSource,
  now: () => number,
  timers: TimerSource,
): WakeLoop {
  let frameId: number | null = null
  let timerId: number | null = null
  let disposed = false

  const invalidate = () => {
    if (disposed || frameId != null) return
    frameId = frames.request((time) => {
      frameId = null
      const deadline = step(time)
      if (timerId != null) {
        timers.clear(timerId)
        timerId = null
      }
      // step() may have disposed the loop (a machine reaching its terminal state);
      // re-arming here would resurrect it after teardown.
      if (deadline != null && !disposed) {
        timerId = timers.set(() => {
          timerId = null
          invalidate()
        }, Math.max(0, deadline - now()))
      }
    })
  }

  return {
    invalidate,
    dispose: () => {
      disposed = true
      if (frameId != null) {
        frames.cancel(frameId)
        frameId = null
      }
      if (timerId != null) {
        timers.clear(timerId)
        timerId = null
      }
    },
  }
}
