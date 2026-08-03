import { describe, expect, test } from 'bun:test'
import { keyIntent } from './keys'

const base = { meta: false, ctrl: false, inInput: false }

describe('keyIntent (the whole map, spec §9.2)', () => {
  test('Enter submits only from the bar', () => {
    expect(keyIntent({ ...base, key: 'Enter', inInput: true })).toBe('submit')
    expect(keyIntent({ ...base, key: 'Enter' })).toBe('none')
  })
  test('Cmd/Ctrl+Enter re-runs globally, even from the bar', () => {
    expect(keyIntent({ ...base, key: 'Enter', meta: true })).toBe('rerun-last')
    expect(keyIntent({ ...base, key: 'Enter', ctrl: true, inInput: true })).toBe('rerun-last')
  })
  test('Esc always maps to dismiss', () => {
    expect(keyIntent({ ...base, key: 'Escape' })).toBe('dismiss')
    expect(keyIntent({ ...base, key: 'Escape', inInput: true })).toBe('dismiss')
  })
  test('/ focuses the prompt unless already typing', () => {
    expect(keyIntent({ ...base, key: '/' })).toBe('focus-prompt')
    expect(keyIntent({ ...base, key: '/', inInput: true })).toBe('none')
  })
  test('arrows scrub only outside inputs', () => {
    expect(keyIntent({ ...base, key: 'ArrowLeft' })).toBe('frame-prev')
    expect(keyIntent({ ...base, key: 'ArrowRight' })).toBe('frame-next')
    expect(keyIntent({ ...base, key: 'ArrowLeft', inInput: true })).toBe('none')
  })
  test('everything else is none', () => {
    expect(keyIntent({ ...base, key: 'a' })).toBe('none')
    expect(keyIntent({ ...base, key: 'Tab' })).toBe('none')
  })
})
