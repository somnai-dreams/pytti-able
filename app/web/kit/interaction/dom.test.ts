import { expect, test } from 'bun:test'
import { createHoverBlocker } from './dom'

test('hover blocker: re-entrant holds, edge-only notifications, idempotent release', () => {
  const blocker = createHoverBlocker()
  let notifications = 0
  blocker.subscribe(() => notifications++)
  expect(blocker.read()).toBe(false)

  const releaseA = blocker.hold()
  expect(blocker.read()).toBe(true)
  expect(notifications).toBe(1) // 0 -> 1 edge

  const releaseB = blocker.hold()
  expect(notifications).toBe(1) // no edge

  releaseA()
  releaseA() // idempotent
  expect(blocker.read()).toBe(true)
  expect(notifications).toBe(1)

  releaseB()
  expect(blocker.read()).toBe(false)
  expect(notifications).toBe(2) // 1 -> 0 edge
})
