// @cs
// interaction/dom: the browser half of the interaction system — the inputs the machines
// and geometry consume, generalized from ClientPointerContext / PointerHoverBlocker.
// View payloads stay generic (never ReactNode); bind rendering in your own layer.
//
//   PointerSnapshot = Readonly<{ x, y, present }>
//   createPointerStore() -> { enabled, read(), subscribe(fn) -> unsub, dispose() }
//     one app-level source for fine-pointer input. enabled is evaluated once at creation:
//     touch-primary devices must NOT turn compatibility mouse events into hover — when
//     disabled, no listeners attach and read() stays {0,0,absent}. subscribe calls the
//     subscriber immediately with the current snapshot. Publishing never renders; pipe
//     into a wake loop / recheck controller instead.
//   createHoverBlocker() -> { read(), subscribe(fn) -> unsub, hold() -> release }
//     re-entrant "pointer hover is blocked" latch (menus/drags hold it; hover surfaces
//     read it as a plain fact). Notifies only on the 0<->1 edges; release is idempotent.
//
// The deadline-driven recheck skeleton these feed into is createWakeLoop (../onestore/core).
//
// DELTAS from the src originals (ClientPointerContext / PointerHoverBlocker), deliberate:
//   - listeners attach at CREATION (construct once at app start), not in a mount effect —
//     dispose() is the teardown contract; constructing requires a window (no SSR call)
//   - createHoverBlocker is a factory, not a module singleton
// @/cs
import { FINE_POINTER } from '../env/dom'
import { createSnapshotChannel } from '../onestore/core'

export type PointerSnapshot = Readonly<{ x: number, y: number, present: boolean }>

export type PointerStore = {
  enabled: boolean
  read: () => PointerSnapshot
  subscribe: (fn: (pointer: PointerSnapshot) => void) => () => void
  dispose: () => void
}

export function createPointerStore(): PointerStore {
  const enabled = window.matchMedia(FINE_POINTER).matches
  const channel = createSnapshotChannel<PointerSnapshot>({ x: 0, y: 0, present: false })

  const onMove = (event: MouseEvent) => {
    channel.publish({ x: event.clientX, y: event.clientY, present: true })
  }
  const onLeave = () => {
    const pointer = channel.read()
    if (!pointer.present) return
    channel.publish({ x: pointer.x, y: pointer.y, present: false })
  }
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') onLeave()
  }

  if (enabled) {
    window.addEventListener('mousemove', onMove, { capture: true, passive: true })
    document.addEventListener('mouseleave', onLeave)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return {
    enabled,
    read: channel.read,
    subscribe: (fn) => {
      fn(channel.read())
      return channel.subscribe(fn)
    },
    dispose: () => {
      if (!enabled) return
      window.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    },
  }
}

export type HoverBlocker = {
  read: () => boolean
  subscribe: (fn: () => void) => () => void
  hold: () => () => void
}

export function createHoverBlocker(): HoverBlocker {
  let holdCount = 0
  let subscribers: (() => void)[] = []
  const notify = () => {
    const list = subscribers
    for (const fn of list) fn()
  }
  return {
    read: () => holdCount > 0,
    subscribe: (fn) => {
      subscribers = [...subscribers, fn]
      return () => {
        subscribers = subscribers.filter((s) => s !== fn)
      }
    },
    hold: () => {
      holdCount++
      if (holdCount === 1) notify()
      let released = false
      return () => {
        if (released) return
        released = true
        holdCount--
        if (holdCount === 0) notify()
      }
    },
  }
}
