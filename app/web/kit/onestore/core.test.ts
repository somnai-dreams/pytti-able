import { expect, test } from 'bun:test'
import { createSnapshotChannel, createWakeLoop, type FrameSource, makeRenderLoop, type RenderLoop, type TimerSource } from './core'

// A hand-pumped frame source: tests drive time explicitly.
function fakeFrames() {
  let nextId = 1
  const pending = new Map<number, (now: number) => void>()
  const frames: FrameSource = {
    request: (cb) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancel: (id) => {
      pending.delete(id)
    },
  }
  return {
    frames,
    pump: (now: number) => {
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb(now)
    },
    pendingCount: () => pending.size,
  }
}

test('scheduleRender coalesces any number of calls into one render per frame', () => {
  const { frames, pump } = fakeFrames()
  const renders: number[] = []
  const loop = makeRenderLoop((now) => renders.push(now), frames, () => 0)
  loop.scheduleRender()
  loop.scheduleRender()
  loop.scheduleRender()
  expect(renders).toEqual([])
  pump(16)
  expect(renders).toEqual([16])
  // and the flag resets: the next schedule renders on the next frame
  loop.scheduleRender()
  pump(32)
  expect(renders).toEqual([16, 32])
})

test('renderNow renders synchronously and cancels a pending frame (no double render)', () => {
  const { frames, pump, pendingCount } = fakeFrames()
  const renders: number[] = []
  const loop = makeRenderLoop((now) => renders.push(now), frames, () => 5)
  loop.scheduleRender()
  loop.renderNow()
  expect(renders).toEqual([5])
  expect(pendingCount()).toBe(0)
  pump(16)
  expect(renders).toEqual([5]) // the scheduled frame was cancelled
})

test('re-entrant render throws (fail loud)', () => {
  const { frames } = fakeFrames()
  // a render that tries to render again synchronously is a design error
  const loop: RenderLoop = makeRenderLoop(
    () => {
      loop.renderNow()
    },
    frames,
    () => 0,
  )
  expect(() => loop.renderNow()).toThrow('re-entrant render')
})

test('scheduling during a render is allowed and lands on the next frame', () => {
  const { frames, pump } = fakeFrames()
  let count = 0
  const loop = makeRenderLoop(
    () => {
      count++
      if (count === 1) loop.scheduleRender() // e.g. an animation still settling
    },
    frames,
    () => 0,
  )
  loop.scheduleRender()
  pump(16)
  expect(count).toBe(1)
  pump(32)
  expect(count).toBe(2)
  pump(48)
  expect(count).toBe(2) // settled: no further schedules
})

test('dispose cancels the pending frame', () => {
  const { frames, pump, pendingCount } = fakeFrames()
  const renders: number[] = []
  const loop = makeRenderLoop((now) => renders.push(now), frames, () => 0)
  loop.scheduleRender()
  loop.dispose()
  expect(pendingCount()).toBe(0)
  pump(16)
  expect(renders).toEqual([])
})

test('snapshot channel: read returns latest, publish pushes to subscribers, never renders', () => {
  const channel = createSnapshotChannel({ x: 0, y: 0 })
  expect(channel.read()).toEqual({ x: 0, y: 0 })
  const seen: number[] = []
  const unsubscribe = channel.subscribe((p) => seen.push(p.x))
  channel.publish({ x: 1, y: 1 })
  channel.publish({ x: 2, y: 2 })
  expect(channel.read()).toEqual({ x: 2, y: 2 })
  expect(seen).toEqual([1, 2])
  unsubscribe()
  channel.publish({ x: 3, y: 3 })
  expect(seen).toEqual([1, 2])
  expect(channel.read().x).toBe(3)
})

test('snapshot channel: unsubscribing mid-publish cannot skip peers', () => {
  const channel = createSnapshotChannel(0)
  const seen: string[] = []
  const unsubA = channel.subscribe(() => {
    seen.push('a')
    unsubA() // self-removal during notification
  })
  channel.subscribe(() => seen.push('b'))
  channel.publish(1)
  expect(seen).toEqual(['a', 'b']) // b still notified this round
  channel.publish(2)
  expect(seen).toEqual(['a', 'b', 'b']) // a gone next round
})

function fakeTimers() {
  let nextId = 1
  const pending = new Map<number, { cb: () => void, at: number }>()
  let clock = 0
  const timers: TimerSource = {
    set: (cb, ms) => {
      const id = nextId++
      pending.set(id, { cb, at: clock + ms })
      return id
    },
    clear: (id) => {
      pending.delete(id)
    },
  }
  return {
    timers,
    now: () => clock,
    advance: (to: number) => {
      clock = to
      const due = [...pending.entries()].filter(([, t]) => t.at <= clock)
      for (const [id, t] of due) {
        pending.delete(id)
        t.cb()
      }
    },
    pendingTimerCount: () => pending.size,
  }
}

test('wake loop: invalidations coalesce, deadlines re-invalidate through the timer', () => {
  const { frames, pump } = fakeFrames()
  const { timers, now, advance, pendingTimerCount } = fakeTimers()
  const steps: number[] = []
  let deadline: number | null = 100
  const loop = createWakeLoop(
    (time) => {
      steps.push(time)
      return deadline
    },
    frames,
    now,
    timers,
  )
  loop.invalidate()
  loop.invalidate()
  pump(0)
  expect(steps).toEqual([0]) // coalesced
  expect(pendingTimerCount()).toBe(1) // armed for the deadline
  deadline = null
  advance(100) // timer fires -> invalidate -> next frame steps again
  pump(101)
  expect(steps).toEqual([0, 101])
  expect(pendingTimerCount()).toBe(0) // null deadline arms nothing
})

test('wake loop: a fresh step replaces the previous deadline timer', () => {
  const { frames, pump } = fakeFrames()
  const { timers, now, pendingTimerCount } = fakeTimers()
  let deadline: number | null = 500
  const loop = createWakeLoop(() => deadline, frames, now, timers)
  loop.invalidate()
  pump(0)
  expect(pendingTimerCount()).toBe(1)
  deadline = 50 // e.g. the machine's next deadline moved closer
  loop.invalidate()
  pump(1)
  expect(pendingTimerCount()).toBe(1) // replaced, not stacked
  loop.dispose()
  expect(pendingTimerCount()).toBe(0)
})
