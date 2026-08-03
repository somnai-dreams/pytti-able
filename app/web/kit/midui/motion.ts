// @cs
// midui/motion: spring physics for game-engine-style render loops.
//
//   msPerAnimationStep = 6 (fixed physics timestep, ms)
//   Spring = { pos, dest, v, k, b }
//   spring(pos, dest=pos, v=0, k=333, b=33) -> Spring
//   springStep(s): MUTATES s.pos, s.v via Fspring=-k*(pos-dest), Fdamper=-b*v, mass=1
//   springGoToEnd(s): MUTATES; snap pos=dest, v=0
//   springMostlyDone(s) -> |v|<0.01 && |dest-pos|<0.01
//   springStepCount(elapsedMs, maxSteps) -> capped step count for a frame (spiral-of-death guard)
//
// NOTE: three deliberate freerange-subset exceptions, accepted and bounded:
// springStep/springGoToEnd mutate their argument (hot-loop choice — springs step several
// times per frame across many simultaneous animations; rebuilding the object each substep
// buys nothing), and spring()'s `destination = position` is a calculated parameter default
// (the ergonomics beat analyzability for a constructor). springMostlyDone and
// springStepCount are the checked surface.
//
// Frame loop pattern (framerate-decoupled, fixed timestep):
//   let acc = 0, last = now
//   render(now) { acc += now - last; last = now
//     const steps = springStepCount(acc, 60); acc -= steps * msPerAnimationStep
//     for (let i = 0; i < steps; i++) springStep(s)
//     draw(s.pos); return !springMostlyDone(s) }
// @/cs

// 6ms per physics step: ~2-3 steps per 60fps frame (16.6ms) and ~1-2 per 120fps frame
// (8.3ms). A larger step (e.g. 8ms) risks whole 120fps frames where the simulation
// doesn't step at all, which reads as jank; a much smaller one burns CPU for no visible
// smoothness gain.
export const msPerAnimationStep = 6

export type Spring = { pos: number, dest: number, v: number, k: number, b: number }

// k = stiffness, b = damping, mass fixed at 1 — adjust k and b to change the curve.
// Parameter feel chooser: https://chenglou.me/react-motion/demos/demo5-spring-parameters-chooser/
export function spring(position: number, destination = position, velocity = 0, stiffness = 333, damping = 33): Spring {
  return { pos: position, dest: destination, v: velocity, k: stiffness, b: damping }
}

export function springStep(config: Spring) {
  // https://blog.maximeheckel.com/posts/the-physics-behind-spring-animations/
  const t = msPerAnimationStep / 1000 // seconds, for the physics equation
  const { pos, dest, v, k, b } = config
  // dest is the spring at rest; current position is its stretched/compressed state
  const Fspring = -k * (pos - dest) // spring stiffness, kg / s^2
  const Fdamper = -b * v // damping, kg / s
  const a = Fspring + Fdamper // acceleration; mass = 1, so F = a
  const newV = v + a * t
  const newPos = pos + newV * t

  config.pos = newPos
  config.v = newV
}

export function springGoToEnd(config: Spring) {
  config.pos = config.dest
  config.v = 0
}

export function springMostlyDone(s: Spring) {
  return Math.abs(s.v) < 0.01 && Math.abs(s.dest - s.pos) < 0.01
}

// How many fixed timesteps to run for elapsedMs of real time, capped so a background
// tab or debugger pause can't queue thousands of catch-up steps (spiral of death) —
// past the cap the animation teleports rather than stalls the frame.
export function springStepCount(elapsedMs: number, maxSteps: number): number {
  console.assert(elapsedMs >= 0)
  console.assert(Number.isInteger(maxSteps))
  console.assert(maxSteps >= 1)
  const uncapped = Math.floor(elapsedMs / msPerAnimationStep)
  const steps = Math.min(maxSteps, uncapped)
  console.assert(steps >= 0)
  console.assert(steps <= maxSteps)
  return steps
}
