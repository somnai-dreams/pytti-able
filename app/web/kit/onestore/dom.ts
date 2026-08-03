// @cs
// onestore/dom: the browser frame source for the render loop.
//   rafRenderLoop(render) -> RenderLoop   requestAnimationFrame-driven, performance.now()
// @/cs
import { makeRenderLoop, type RenderLoop } from './core'

export function rafRenderLoop(render: (now: number) => void): RenderLoop {
  return makeRenderLoop(
    render,
    { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) },
    () => performance.now(),
  )
}
