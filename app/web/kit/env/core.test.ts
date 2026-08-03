import { expect, test } from 'bun:test'
import { defaultEnv, parseCssPx } from './core'

test('parseCssPx: absent var is 0, px decimals parse, everything else throws', () => {
  expect(parseCssPx('')).toBe(0)
  expect(parseCssPx('  ')).toBe(0)
  expect(parseCssPx('16px')).toBe(16)
  expect(parseCssPx(' 16.5px ')).toBe(16.5)
  expect(parseCssPx('0px')).toBe(0)
  expect(parseCssPx('-2px')).toBe(-2)
  expect(parseCssPx('.5px')).toBe(0.5)
  // one interpretation across CSS and JS: reject what CSS length contexts reject or
  // what no env() setup produces
  expect(() => parseCssPx('16')).toThrow('unparseable CSS length') // unitless
  expect(() => parseCssPx('px')).toThrow('unparseable CSS length') // dropped number
  expect(() => parseCssPx('0x1Fpx')).toThrow('unparseable CSS length') // hex
  expect(() => parseCssPx('1e2px')).toThrow('unparseable CSS length') // exponent
  expect(() => parseCssPx('abc')).toThrow('unparseable CSS length')
  expect(() => parseCssPx('1em')).toThrow('unparseable CSS length')
})

test('defaultEnv is a neutral desktop snapshot', () => {
  const env = defaultEnv()
  expect(env.viewportX).toBeGreaterThan(0)
  expect(env.pointerFine).toBe(true)
  expect(env.touch).toBe(false)
  expect(env.safeArea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
})
