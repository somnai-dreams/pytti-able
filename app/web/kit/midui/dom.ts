// @cs
// midui/dom: the browser half of the kernel — everything here touches rAF or the DOM,
// which is why it lives outside num.ts/motion.ts (the pure core).
//
//   makeScheduler(render: (now: number) => boolean) -> scheduleRender: () => void
//     rAF-coalesced render loop: any number of scheduleRender() calls within a frame run
//     render once; render returning true re-schedules itself (animation still live).
// @/cs

export function makeScheduler(render: ((now: number) => boolean)) {
  let scheduledRender = false
  return function scheduleRender() {
    if (scheduledRender) return
    scheduledRender = true

    requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) { // eye-grabbing name: no "(anonymous)" in the profiler
      scheduledRender = false
      if (render(now)) scheduleRender()
    })
  }
}
