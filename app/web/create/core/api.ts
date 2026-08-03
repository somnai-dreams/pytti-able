// @cs
// create/core/api: THE parse boundary. Every byte that enters the app from the server
// (REST bodies, SSE payloads) passes through one of these parsers and comes out as a
// typed model value — or throws (a malformed body from our own server is a bug, not a
// UX state). Expected, recoverable outcomes (400 preflight, 202 queued) are DATA in the
// returned unions, never exceptions.
//
// String/JSON domain — outside freerange's numeric subset; api.test.ts is the checked
// surface.
//
// functions:
//   parseSessionSummary(raw) -> Tile                 GET /api/sessions items (S1 fields:
//     scenes/width/height; null dims parse to 512x512 + legacyDims so masonry never sees
//     a hole — the ONE documented-lenient rule, legacy snapshots are a shaky boundary)
//   parseSessions(raw) -> Tile[]
//   parseSessionDetail(raw) -> { tile, config }      GET /api/sessions/{id}
//   parseQueue(raw) -> QueueSlot | null              GET /api/queue
//   parseSchemaFields(raw) -> string[]               GET /api/schema (field names only)
//   parseStartResult(status, raw) -> StartResult     POST /api/sessions 201/202/400
//   parseEncodeStart(raw) -> jobId                   POST /api/sessions/{id}/encode 201
//   parseErrorBody(raw) -> string                    any {"error": ...} body
//   parseSseEvent(type, raw) -> SseEvent             tagged union over the 5 consumed
//     event streams (state splits into live/terminal); unknown type throws
//   frameUrl(id, index) / thumbUrl(id, index)        1-based, index >= 1 asserted
//   artifactUrl(id, name)
// @/cs
import type {
  Artifact,
  Phase,
  QueueSlot,
  SessionState,
  SseEvent,
  Substate,
  TerminalState,
  Tile,
} from './model'

function ctxErr(ctx: string, want: string, v: unknown): Error {
  return new Error(`${ctx}: expected ${want}, got ${JSON.stringify(v)}`)
}

function asRecord(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) throw ctxErr(ctx, 'object', v)
  return v as Record<string, unknown>
}

function asArray(v: unknown, ctx: string): unknown[] {
  if (!Array.isArray(v)) throw ctxErr(ctx, 'array', v)
  return v
}

function asString(v: unknown, ctx: string): string {
  if (typeof v !== 'string') throw ctxErr(ctx, 'string', v)
  return v
}

function asNumber(v: unknown, ctx: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) throw ctxErr(ctx, 'number', v)
  return v
}

function asNumberOrNull(v: unknown, ctx: string): number | null {
  if (v == null) return null
  return asNumber(v, ctx)
}

function asStringOrNull(v: unknown, ctx: string): string | null {
  if (v == null) return null
  return asString(v, ctx)
}

// Server emits true for imported sessions and null/absent for studio ones.
function asFlag(v: unknown, ctx: string): boolean {
  if (v == null) return false
  if (typeof v !== 'boolean') throw ctxErr(ctx, 'boolean or null', v)
  return v
}

// failExcerpt is the last (up to 2) stdout lines AS A LIST (server: fail_tail[-2:]);
// normalized here to one newline-joined string — the tile model wants "first line".
function asFailExcerpt(v: unknown, ctx: string): string | null {
  if (v == null) return null
  const lines = asArray(v, ctx)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) out.push(asString(lines[i], `${ctx}[${i}]`))
  return out.length === 0 ? null : out.join('\n')
}

const SESSION_STATES: readonly SessionState[] = ['rendering', 'stopped', 'done', 'failed', 'imported']
const TERMINAL_STATES: readonly TerminalState[] = ['done', 'stopped', 'failed']
const SUBSTATES: readonly Substate[] = ['launching', 'loading_models', 'rendering', 'stopping']
const PHASES: readonly Phase[] = ['pre_animation', 'interpolation', 'scene']

function asEnum<T extends string>(v: unknown, options: readonly T[], ctx: string): T {
  if (typeof v !== 'string') throw ctxErr(ctx, `one of ${options.join('|')}`, v)
  for (const option of options) {
    if (v === option) return option
  }
  throw ctxErr(ctx, `one of ${options.join('|')}`, v)
}

function parseArtifact(raw: unknown, ctx: string): Artifact {
  const r = asRecord(raw, ctx)
  return {
    name: asString(r['name'], `${ctx}.name`),
    bytes: asNumber(r['bytes'], `${ctx}.bytes`),
    fps: asNumberOrNull(r['fps'], `${ctx}.fps`),
    format: asEnum(r['format'], ['mp4', 'prores'] as const, `${ctx}.format`),
  }
}

export function parseSessionSummary(raw: unknown): Tile {
  const r = asRecord(raw, 'session summary')
  const id = asString(r['id'], 'summary.id')
  const rawArtifacts = asArray(r['artifacts'], `summary(${id}).artifacts`)
  const artifacts: Artifact[] = []
  for (let i = 0; i < rawArtifacts.length; i++) {
    artifacts.push(parseArtifact(rawArtifacts[i], `summary(${id}).artifacts[${i}]`))
  }

  // The three S1 config-snapshot fields: null for sessions without a snapshot, and a
  // legacy hydra yaml can hold arbitrarily-typed values — the documented-lenient rule
  // maps any non-conforming value to null (dims then fall to 512x512 + legacyDims).
  const rawScenes = r['scenes']
  const scenes = typeof rawScenes === 'string' ? rawScenes : null
  const rawWidth = r['width']
  const rawHeight = r['height']
  const hasDims = typeof rawWidth === 'number' && rawWidth > 0 && typeof rawHeight === 'number' && rawHeight > 0

  return {
    id,
    slug: asString(r['slug'], `summary(${id}).slug`),
    scenes,
    state: asEnum(r['state'], SESSION_STATES, `summary(${id}).state`),
    seed: asNumberOrNull(r['seed'], `summary(${id}).seed`),
    startedAt: asNumber(r['startedAt'], `summary(${id}).startedAt`),
    endedAt: asNumberOrNull(r['endedAt'], `summary(${id}).endedAt`),
    frames: asNumber(r['frames'], `summary(${id}).frames`),
    stepsDone: asNumberOrNull(r['stepsDone'], `summary(${id}).stepsDone`) ?? 0,
    stepsTotal: asNumberOrNull(r['stepsTotal'], `summary(${id}).stepsTotal`) ?? 0,
    sizeX: hasDims ? rawWidth : 512,
    sizeY: hasDims ? rawHeight : 512,
    legacyDims: !hasDims,
    forkedFrom: asStringOrNull(r['forkedFrom'], `summary(${id}).forkedFrom`),
    imported: asFlag(r['imported'], `summary(${id}).imported`),
    artifacts,
    failExcerpt: asFailExcerpt(r['failExcerpt'], `summary(${id}).failExcerpt`),
    live: null,
    detail: null,
  }
}

export function parseSessions(raw: unknown): Tile[] {
  const r = asRecord(raw, 'GET /api/sessions body')
  const list = asArray(r['sessions'], 'sessions')
  const tiles: Tile[] = []
  for (const item of list) tiles.push(parseSessionSummary(item))
  return tiles
}

export function parseSessionDetail(raw: unknown): { tile: Tile; config: Record<string, unknown> } {
  const tile = parseSessionSummary(raw)
  const r = asRecord(raw, 'session detail')
  const config = asRecord(r['config'], `detail(${tile.id}).config`)
  return { tile, config }
}

export function parseQueue(raw: unknown): QueueSlot | null {
  const r = asRecord(raw, 'GET /api/queue body')
  const queued = r['queued']
  if (queued == null) return null
  const q = asRecord(queued, 'queue.queued')
  return { id: asString(q['id'], 'queue.queued.id'), slug: asString(q['slug'], 'queue.queued.slug') }
}

export function parseSchemaFields(raw: unknown): string[] {
  const r = asRecord(raw, 'GET /api/schema body')
  const fields = asRecord(r['fields'], 'schema.fields')
  const names = Object.keys(fields)
  if (names.length === 0) throw new Error('schema.fields: empty — the server schema is broken')
  return names
}

export function parseErrorBody(raw: unknown): string {
  const r = asRecord(raw, 'error body')
  return asString(r['error'], 'error body.error')
}

export type StartResult =
  | { kind: 'started'; sessionId: string; seed: number }
  | { kind: 'queued'; queuedId: string; replaced: boolean }
  | { kind: 'rejected'; message: string }

// POST /api/sessions {"mode":"queue"} can only produce 201 / 202 / 400 (409 is the
// "now"-mode busy answer and never fires for queue) — anything else throws.
export function parseStartResult(status: number, raw: unknown): StartResult {
  if (status === 201) {
    const r = asRecord(raw, 'POST /api/sessions 201 body')
    return {
      kind: 'started',
      sessionId: asString(r['sessionId'], 'start.sessionId'),
      seed: asNumber(r['seed'], 'start.seed'),
    }
  }
  if (status === 202) {
    const r = asRecord(raw, 'POST /api/sessions 202 body')
    const replaced = r['replaced']
    if (typeof replaced !== 'boolean') throw ctxErr('start.replaced', 'boolean', replaced)
    return { kind: 'queued', queuedId: asString(r['queued'], 'start.queued'), replaced }
  }
  if (status === 400) {
    const r = asRecord(raw, 'POST /api/sessions 400 body')
    // Preflight failure carries issues; other 400s carry only {error}.
    const issues = r['issues']
    if (Array.isArray(issues)) {
      for (const rawIssue of issues) {
        const issue = asRecord(rawIssue, 'start.issues[]')
        if (issue['severity'] === 'error') {
          return {
            kind: 'rejected',
            message: `${asString(issue['field'], 'issue.field')}: ${asString(issue['message'], 'issue.message')}`,
          }
        }
      }
    }
    return { kind: 'rejected', message: parseErrorBody(raw) }
  }
  throw new Error(`POST /api/sessions: unexpected status ${status}`)
}

export function parseEncodeStart(raw: unknown): string {
  const r = asRecord(raw, 'POST encode 201 body')
  return asString(r['jobId'], 'encode.jobId')
}

export function parseSseEvent(type: string, raw: unknown): SseEvent {
  switch (type) {
    case 'state': {
      const r = asRecord(raw, 'sse state')
      const sessionId = asString(r['sessionId'], 'sse state.sessionId')
      const state = asString(r['state'], 'sse state.state')
      for (const terminal of TERMINAL_STATES) {
        if (state === terminal) {
          const summary = asRecord(r['summary'], 'sse state.summary')
          return {
            kind: 'state-terminal',
            sessionId,
            state: terminal,
            seed: asNumberOrNull(r['seed'], 'sse state.seed'),
            summary: {
              steps: asNumber(summary['steps'], 'sse state.summary.steps'),
              frames: asNumber(summary['frames'], 'sse state.summary.frames'),
              elapsedSec: asNumber(summary['elapsedSec'], 'sse state.summary.elapsedSec'),
            },
          }
        }
      }
      return { kind: 'state-live', sessionId, substate: asEnum(state, SUBSTATES, 'sse state.state') }
    }
    case 'progress': {
      const r = asRecord(raw, 'sse progress')
      return {
        kind: 'progress',
        sessionId: asString(r['sessionId'], 'sse progress.sessionId'),
        step: asNumber(r['step'], 'sse progress.step'),
        stepsTotal: asNumber(r['stepsTotal'], 'sse progress.stepsTotal'),
        scene: asNumber(r['scene'], 'sse progress.scene'),
        sceneCount: asNumber(r['sceneCount'], 'sse progress.sceneCount'),
        phase: asEnum(r['phase'], PHASES, 'sse progress.phase'),
        sPerStep: asNumber(r['sPerStep'], 'sse progress.sPerStep'),
        etaSec: asNumber(r['etaSec'], 'sse progress.etaSec'),
      }
    }
    case 'frame': {
      const r = asRecord(raw, 'sse frame')
      return {
        kind: 'frame',
        sessionId: asString(r['sessionId'], 'sse frame.sessionId'),
        savedTotal: asNumber(r['savedTotal'], 'sse frame.savedTotal'),
      }
    }
    case 'queue': {
      const r = asRecord(raw, 'sse queue')
      return { kind: 'queue', queued: parseQueue(r) }
    }
    case 'encode': {
      const r = asRecord(raw, 'sse encode')
      const state = asEnum(r['state'], ['running', 'done', 'failed', 'cancelled'] as const, 'sse encode.state')
      const outUrl = asStringOrNull(r['outUrl'], 'sse encode.outUrl')
      if (state === 'done' && outUrl == null) throw new Error('sse encode: done event without outUrl')
      return {
        kind: 'encode',
        jobId: asString(r['jobId'], 'sse encode.jobId'),
        sessionId: asString(r['sessionId'], 'sse encode.sessionId'),
        framesDone: asNumber(r['framesDone'], 'sse encode.framesDone'),
        framesTotal: asNumber(r['framesTotal'], 'sse encode.framesTotal'),
        state,
        outUrl,
      }
    }
    default:
      throw new Error(`parseSseEvent: unknown event type "${type}"`)
  }
}

// --- URL builders. Frame/thumb indices are 1-based (server contract: frames == N means
// indices 1..N). Session ids go in raw (server does not percent-decode paths — the bench
// does the same); artifact names are user-adjacent, so they get encoded.
export function frameUrl(id: string, index: number): string {
  console.assert(Number.isInteger(index))
  console.assert(index >= 1)
  return `/api/sessions/${id}/frames/${index}`
}

export function thumbUrl(id: string, index: number): string {
  console.assert(Number.isInteger(index))
  console.assert(index >= 1)
  return `/api/sessions/${id}/thumbs/${index}`
}

export function artifactUrl(id: string, name: string): string {
  return `/api/sessions/${id}/artifacts/${encodeURIComponent(name)}`
}
