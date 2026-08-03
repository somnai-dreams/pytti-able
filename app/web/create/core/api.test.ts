import { describe, expect, test } from 'bun:test'
import {
  artifactUrl,
  frameUrl,
  parseErrorBody,
  parseQueue,
  parseSchemaFields,
  parseSessionDetail,
  parseSessions,
  parseSessionSummary,
  parseSseEvent,
  parseStartResult,
  thumbUrl,
} from './api'

const SUMMARY = {
  id: 's-0002-infinite-fractal-mushroom',
  slug: 'infinite-fractal-mushroom',
  state: 'done',
  seed: 3982117,
  startedAt: 1753000000000,
  endedAt: 1753000600000,
  frames: 30,
  stepsDone: 200,
  stepsTotal: 200,
  sPerStepAvg: 1.2,
  elapsedSec: 240,
  forkedFrom: null,
  deltaSummary: null,
  artifacts: [{ name: 's-0002_12fps.mp4', bytes: 1024, fps: 12, format: 'mp4' }],
  imported: null,
  exitCode: 0,
  failExcerpt: null,
  scenes: 'infinite fractal mushroom forest',
  width: 512,
  height: 512,
}

describe('parseSessionSummary', () => {
  test('a studio session round-trips', () => {
    const tile = parseSessionSummary(SUMMARY)
    expect(tile.id).toBe('s-0002-infinite-fractal-mushroom')
    expect(tile.state).toBe('done')
    expect(tile.scenes).toBe('infinite fractal mushroom forest')
    expect(tile.sizeX).toBe(512)
    expect(tile.sizeY).toBe(512)
    expect(tile.legacyDims).toBe(false)
    expect(tile.imported).toBe(false)
    expect(tile.artifacts).toEqual([{ name: 's-0002_12fps.mp4', bytes: 1024, fps: 12, format: 'mp4' }])
    expect(tile.live).toBeNull()
    expect(tile.detail).toBeNull()
  })

  test('legacy import without snapshot: null dims -> 512x512 + legacyDims', () => {
    const tile = parseSessionSummary({ ...SUMMARY, state: 'imported', imported: true, scenes: null, width: null, height: null, endedAt: null, seed: null })
    expect(tile.scenes).toBeNull()
    expect(tile.sizeX).toBe(512)
    expect(tile.legacyDims).toBe(true)
    expect(tile.imported).toBe(true)
  })

  test('legacy garbage in the config-derived fields maps to null, not a crash', () => {
    const tile = parseSessionSummary({ ...SUMMARY, scenes: 123, width: '512', height: -1 })
    expect(tile.scenes).toBeNull()
    expect(tile.legacyDims).toBe(true)
  })

  test('a broken summary throws with the field named', () => {
    expect(() => parseSessionSummary({ ...SUMMARY, state: 'exploded' })).toThrow(/state/)
    expect(() => parseSessionSummary({ ...SUMMARY, frames: null })).toThrow(/frames/)
    expect(() => parseSessionSummary({ ...SUMMARY, artifacts: [{ name: 'x' }] })).toThrow(/artifacts/)
  })

  test('failExcerpt arrives as a list of lines (server fail_tail[-2:]) -> newline-joined', () => {
    const tile = parseSessionSummary({ ...SUMMARY, state: 'failed', failExcerpt: ['line one', 'line two'] })
    expect(tile.failExcerpt).toBe('line one\nline two')
    expect(parseSessionSummary({ ...SUMMARY, failExcerpt: [] }).failExcerpt).toBeNull()
    expect(() => parseSessionSummary({ ...SUMMARY, failExcerpt: 'a plain string' })).toThrow(/failExcerpt/)
  })
})

describe('parseSessions / parseSessionDetail / parseQueue / parseSchemaFields', () => {
  test('sessions list', () => {
    expect(parseSessions({ sessions: [SUMMARY] })).toHaveLength(1)
    expect(() => parseSessions({})).toThrow(/sessions/)
  })
  test('detail keeps the config record', () => {
    const { tile, config } = parseSessionDetail({ ...SUMMARY, config: { scenes: 'p', seed: 1 } })
    expect(tile.id).toBe(SUMMARY.id)
    expect(config['seed']).toBe(1)
    expect(() => parseSessionDetail(SUMMARY)).toThrow(/config/)
  })
  test('queue slot and empty slot', () => {
    expect(parseQueue({ queued: null })).toBeNull()
    expect(parseQueue({ queued: { id: 's-9', slug: 'x-y-z' } })).toEqual({ id: 's-9', slug: 'x-y-z' })
    expect(() => parseQueue({ queued: { id: 's-9' } })).toThrow(/slug/)
  })
  test('schema fields -> names', () => {
    expect(parseSchemaFields({ fields: { scenes: {}, width: {} } })).toEqual(['scenes', 'width'])
    expect(() => parseSchemaFields({ fields: {} })).toThrow(/empty/)
  })
})

describe('parseStartResult', () => {
  test('201 started', () => {
    expect(parseStartResult(201, { sessionId: 's-3', seed: 9, startedImmediately: true })).toEqual({
      kind: 'started',
      sessionId: 's-3',
      seed: 9,
    })
  })
  test('202 queued', () => {
    expect(parseStartResult(202, { queued: 's-4', replaced: true })).toEqual({ kind: 'queued', queuedId: 's-4', replaced: true })
  })
  test('400 preflight names the first error issue field', () => {
    const result = parseStartResult(400, {
      error: 'preflight failed',
      issues: [
        { field: 'width', section: 'canvas', severity: 'warn', message: 'big' },
        { field: 'scenes', section: 'prompt', severity: 'error', message: 'bad weight' },
      ],
    })
    expect(result).toEqual({ kind: 'rejected', message: 'scenes: bad weight' })
  })
  test('400 without error issues falls back to the error string', () => {
    expect(parseStartResult(400, { error: 'nope', issues: [] })).toEqual({ kind: 'rejected', message: 'nope' })
  })
  test('unexpected status throws', () => {
    expect(() => parseStartResult(409, { error: 'busy' })).toThrow(/409/)
  })
})

describe('parseSseEvent', () => {
  test('live state', () => {
    expect(parseSseEvent('state', { sessionId: 's-1', state: 'loading_models', seed: 5 })).toEqual({
      kind: 'state-live',
      sessionId: 's-1',
      substate: 'loading_models',
    })
  })
  test('terminal state carries the summary', () => {
    expect(
      parseSseEvent('state', {
        sessionId: 's-1',
        state: 'done',
        exitCode: 0,
        seed: 5,
        summary: { steps: 200, frames: 30, elapsedSec: 240, sPerStepAvg: 1.1 },
      }),
    ).toEqual({
      kind: 'state-terminal',
      sessionId: 's-1',
      state: 'done',
      seed: 5,
      summary: { steps: 200, frames: 30, elapsedSec: 240 },
    })
  })
  test('progress', () => {
    const ev = parseSseEvent('progress', {
      sessionId: 's-1', step: 10, stepsTotal: 200, scene: 0, sceneCount: 1,
      phase: 'scene', sPerStep: 1.5, etaSec: 280, elapsedSec: 15, nextFrameInSec: 3,
    })
    expect(ev).toEqual({
      kind: 'progress', sessionId: 's-1', step: 10, stepsTotal: 200, scene: 0, sceneCount: 1,
      phase: 'scene', sPerStep: 1.5, etaSec: 280,
    })
  })
  test('frame keeps only savedTotal', () => {
    expect(parseSseEvent('frame', { sessionId: 's-1', index: 4, step: 40, url: 'u', thumbUrl: 't', savedTotal: 4 })).toEqual({
      kind: 'frame',
      sessionId: 's-1',
      savedTotal: 4,
    })
  })
  test('queue', () => {
    expect(parseSseEvent('queue', { queued: null })).toEqual({ kind: 'queue', queued: null })
  })
  test('encode done requires outUrl', () => {
    expect(() => parseSseEvent('encode', { jobId: 'enc-1', sessionId: 's-1', framesDone: 9, framesTotal: 9, state: 'done' })).toThrow(/outUrl/)
    expect(
      parseSseEvent('encode', { jobId: 'enc-1', sessionId: 's-1', framesDone: 9, framesTotal: 9, state: 'done', outUrl: '/api/x' }),
    ).toEqual({ kind: 'encode', jobId: 'enc-1', sessionId: 's-1', framesDone: 9, framesTotal: 9, state: 'done', outUrl: '/api/x' })
  })
  test('unknown type throws', () => {
    expect(() => parseSseEvent('log', { line: 'x' })).toThrow(/unknown/)
  })
})

describe('url builders', () => {
  test('1-based frame/thumb urls', () => {
    expect(frameUrl('s-1', 12)).toBe('/api/sessions/s-1/frames/12')
    expect(thumbUrl('s-1', 1)).toBe('/api/sessions/s-1/thumbs/1')
  })
  test('artifact names are encoded', () => {
    expect(artifactUrl('s-1', 'a b.mp4')).toBe('/api/sessions/s-1/artifacts/a%20b.mp4')
  })
})

describe('parseErrorBody', () => {
  test('extracts the error string', () => {
    expect(parseErrorBody({ error: 'boom' })).toBe('boom')
    expect(() => parseErrorBody({})).toThrow()
  })
})
