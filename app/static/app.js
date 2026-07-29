// PYTTI STUDIO — entire client. One module, no imports, no build step.
// Architecture: single global `state`; events (input + SSE + async results) are
// stored raw into state.events; tick() drains and mutates state; render()
// projects state onto DOM chunks cached in `domCache` (vibescript ui.md).

'use strict'

// ════════════════════════════════════════════════════════════════════════════
// § HELPERS
// ════════════════════════════════════════════════════════════════════════════

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text != null) n.textContent = text
  return n
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;')
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

// Wellons lowbias32 (vibescript ui.md) — deterministic pseudo-random
function hash(n) {
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0x735a2d97)
  return (((n >>> 15) ^ n) >>> 0) / 0x100000000
}

function pad4(n) { return String(n).padStart(4, '0') }

function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—'
  sec = Math.max(0, Math.round(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${s > 0 && m < 10 ? String(s).padStart(2, '0') + 's' : ''}`
  return `${s}s`
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + 'GB'
  if (b >= 1e6) return Math.round(b / 1e6) + 'MB'
  return Math.round(b / 1e3) + 'KB'
}

function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}

function slugify(text) {
  const words = text.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).filter((w) => w.length > 0)
  return words.slice(0, 3).join('-') || 'untitled'
}

// ════════════════════════════════════════════════════════════════════════════
// § STATE (spec §6, verbatim)
// ════════════════════════════════════════════════════════════════════════════

const state = {
  // ── boot-lifetime (fetched once at load, immutable after) ─────────────
  schema: null,            // /api/schema payload: field metadata, groups, predicates, parked flags
  calibration: null,       // /api/calibration buckets
  health: null,            // /api/health payload: device / models / ffmpeg checks (post-spec addition)
  firstBoot: false,        // bool: show first-boot check

  // ── server-truth mirrors (lifetime: app; mutated only by SSE/REST results) ──
  sessions: { byId: {}, order: [] },   // {[id]: SessionSummary}; order newest-first
  presets: [],                         // [{name, values, savedAt}]
  queue: null,                         // {id, slug} | null — the one slot

  // ── live render (lifetime: one render; reset on state:done/stopped/failed) ──
  live: {
    sessionId: null,       // string | null — THE binding cue for PiP/status strip
    state: 'idle',         // 'idle'|'launching'|'loading_models'|'rendering'|'stopping'
    step: 0, stepsTotal: 0,
    scene: 0, sceneCount: 1,
    phase: 'scene',        // 'pre_animation'|'scene'|'interpolation'
    sPerStep: 0, etaSec: 0, elapsedSec: 0, nextFrameInSec: 0,
    frames: 0, seed: null,
    itsRing: new Float32Array(120), itsHead: 0,   // sparkline ring buffer
    logRing: [], logHead: 0,                      // capped 500 cleaned lines {line, kind}
  },

  // ── draft (server-persisted via debounced PUT; lifetime: app) ─────────
  draft: {
    values: {},            // full config field map, schema-typed
    forkOf: null,          // string | null — lineage of the *next* session
    seedLocked: true,      // fork sets true; fresh draft false
    dirtySinceRun: false,  // drives '● edited' + RUN morph
    saveTimer: 0,          // debounce handle (not serialized)
    preflight: { ok: true, issues: [], estimate: null },  // refreshed on change (debounced)
  },

  // ── selection / viewing (ephemeral, client-only) ──────────────────────
  sel: {
    sessionId: null,       // what the Stage shows; null → follow live
    frameIdx: null,        // null = follow latest; number = scrubbed/pinned
    playing: false,        // filmstrip playback at authored fps
    compare: null,         // null | { otherId, locked: true, stepOffset: 0, focus:'a'|'b' }
  },

  // ── UI shell (ephemeral) ───────────────────────────────────────────────
  ui: {
    archiveOpen: false, engineRoomOpen: false, helpOpen: false,
    inspectorOpen: false, inspectorDiffAgainst: null,   // string | null
    logOpen: false, benchCollapsed: false,
    benchSections: { prompt: true, canvas: false, startFrom: false, motion: false,
                     coherence: false, time: true, engine: false, audio: false },
    sheet: null,           // null | {kind:'encode', sessionId, fps, format} | {kind:'firstBoot'}
                           // extended kinds (see deviations): {kind:'presets'} | {kind:'browse', field, path}
    toast: null,           // null | {text, actions:[{label, event}], expiresAt}
    archiveFilter: { text: '', status: 'all', hasVideo: false, sort: 'newest' },
    engineRoomSearch: '',
    confirmPending: null,  // null | {kind:'longRun'|'delete'|'preempt', payload}
  },

  // ── encode job mirror (lifetime: one job) ─────────────────────────────
  encode: null,            // null | {jobId, sessionId, framesDone, framesTotal, state, outUrl}

  // ── transport plumbing ─────────────────────────────────────────────────
  sse: { connected: false, lastEventId: 0 },
  events: [],              // input + SSE queue; drained fully each tick, never rendered from directly
  dirty: {},               // chunk-name → bool, set by tick, cleared by render
  now: 0,                  // performance.now() at tick start (drives springs, countdown)
}

// ════════════════════════════════════════════════════════════════════════════
// § SPRINGS + ANIMATION PLUMBING (lives beside domCache, not in state — §7)
// ════════════════════════════════════════════════════════════════════════════

const msPerAnimationStep = 6

function spring(pos, dest = pos, v = 0, k = 220, b = 26) {
  return { pos, dest, v, k, b }
}
function springStep(s) {
  const t = msPerAnimationStep / 1000
  const a = -s.k * (s.pos - s.dest) - s.b * s.v
  s.v += a * t
  s.pos += s.v * t
}
function springDone(s) { return Math.abs(s.v) < 0.01 && Math.abs(s.dest - s.pos) < 0.001 }
function springSnap(s) { s.pos = s.dest; s.v = 0 }

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

// Animation + ephemeral view plumbing. Not app state: pulse/decays/springs only
// shape motion; hover/drag are per-frame pointer interpretation scratch.
const anim = {
  animatedUntilTime: null,
  springs: {
    engine: spring(0), help: spring(0), archive: spring(0),
    inspector: spring(0), sheet: spring(0), confirm: spring(0),
    fling: spring(0),    // filmstrip scrub inertia (pos = frame index)
  },
  flinging: false,
  pulse: 0,              // REC pulse, fed 1.0 by each progress event, decays
  lastProgressAt: 0,     // wall-clock ms of last progress event (countdown display)
  decays: new Map(),     // readout key → state.now when its value last changed (phosphor decay)
  playLastAt: 0,         // filmstrip playback clock
}

function decayMark(key, changed) { if (changed) anim.decays.set(key, state.now) }
function decayColor(key) {
  const at = anim.decays.get(key)
  return at != null && state.now - at < 600 ? 'var(--accent)' : 'var(--text)'
}

// Per-frame pointer scratch
const hover = { scrubCardId: null, scrubFrac: 0, fsIdx: null }   // fsIdx: filmstrip hover-peek frame
const drag = { kind: null, startX: 0, lastX: 0, lastT: 0, vx: 0, startIdx: 0 }

// Side-effect requests, set by tick, applied and cleared at end of render
const fx = {
  focusField: null,        // field name → focus its input
  forceValue: null,        // {field, caret} → write value into a focused input (after click-insert)
  scrollLogBottom: false,
  fsFollow: false,         // scroll filmstrip to end
  scrollToField: null,     // field name → scrollIntoView
  scrollGroup: null,       // engine-room group name → scrollIntoView
  focusEngineSearch: false,
  blur: false,             // Esc inside a field
  copyText: null,          // clipboard write (FINDER fallback)
}

const timers = { preflight: 0, coarse: 0 }
const pendingDetails = new Set()   // session ids with a detail fetch in flight

// ════════════════════════════════════════════════════════════════════════════
// § domCache (outside state — vibescript ui.md). Lifetimes commented per entry.
// ════════════════════════════════════════════════════════════════════════════

function grab(id) {
  const n = document.getElementById(id)
  if (n == null) throw new Error(`static shell is missing #${id}`)
  return n
}

const domCache = {
  // permanent — cache lifetime: app
  cols: grab('cols'),
  status: {
    root: grab('status-strip'), brand: grab('ss-brand'), led: grab('ss-led'),
    label: grab('ss-label'), stop: grab('ss-stop'), queueChip: grab('ss-queue'),
  },
  lib: {  // rail chrome permanent; cards JIT + inline eviction (evict on scroll-out)
    scroll: grab('lib-scroll'), cards: grab('lib-cards'),
    padTop: grab('lib-pad-top'), padBot: grab('lib-pad-bot'), empty: grab('lib-empty'),
    map: new Map(),        // sessionId → {node, thumb, status, idT, delta, meta, entry:spring} — lifetime: visibility
  },
  stageHead: {  // permanent
    id: grab('sh-id'), state: grab('sh-state'), meta: grab('sh-meta'), actions: grab('sh-actions'),
  },
  stage: {  // permanent double buffer — never wiped, never blanks mid-session
    root: grab('stage'), imgs: [grab('stage-a'), grab('stage-b')],
    front: 0, shownUrl: null, loadingUrl: null, forSession: null,   // double-buffer bookkeeping (DOM cache status, not app state)
    placard: grab('stage-placard'), summary: grab('stage-summary'), starters: grab('stage-starters'),
    startersBuilt: false,
  },
  pip: { root: grab('pip'), img: grab('pip-img'), shownUrl: null },  // permanent
  filmstrip: {  // chrome permanent; thumbs JIT + occlusion — lifetime: visibility
    root: grab('filmstrip'), scroll: grab('fs-scroll'), track: grab('fs-track'),
    liveBtn: grab('fs-live'), count: grab('fs-count'),
    map: new Map(),        // frameIdx → <img> — lifetime: visibility
    forSession: null,      // which session the thumbs belong to (wipe map on change)
  },
  deck: {  // permanent text projection (mono font ⇒ no layout shimmer)
    root: grab('progress-deck'), countdown: grab('pd-countdown'),
    sceneBar: grab('pd-scenebar'), fill: grab('pd-fill'), segments: grab('pd-segments'),
    segCount: -1,          // wipe-recreate segments only when scene count changes
    step: grab('pd-step'), rate: grab('pd-rate'), phase: grab('pd-phase'), elapsed: grab('pd-elapsed'),
    spark: grab('pd-spark'),
  },
  log: {  // append-only + trim (cap 500); auto-scroll tracked in render
    line: grab('log-line'), badge: grab('ll-badge'), text: grab('ll-text'),
    drawer: grab('log-drawer'), rows: grab('log-rows'),
    appended: 0,           // how many ring entries already have row nodes
  },
  bench: {  // built once at boot from schema — permanent; scenes textarea+overlay stateful, never recreated
    root: grab('bench'), head: grab('bench-head'), state: grab('bench-state'),
    title: grab('bench-title'), presetsBtn: grab('bench-presets'), collapseBtn: grab('bench-collapse'),
    lineage: grab('bench-lineage'), scroll: grab('bench-scroll'), sections: grab('bench-sections'),
    sec: {},               // sectionKey → {root, head, badge, summary, body}
    widgets: new Map(),    // field → widget record {kind, row, input, ...}
    scenes: null,          // {ta, overlay, lastHtml, mapStrip, cheat}
    built: false,
  },
  runBar: {  // permanent — button morph is class+text projection
    root: grab('run-bar'), seedVal: grab('seed-val'), seedLock: grab('seed-lock'),
    seedRoll: grab('seed-roll'), cost: grab('cost-meter'), issues: grab('run-issues'),
    buttons: grab('run-buttons'),
  },
  engineRoom: {  // JIT built on first open from schema, then permanent
    root: grab('engine-room'), built: false,
    search: null, count: null, nav: null, groups: new Map(),  // groupName → {root, head, body}
    rows: new Map(),       // field → {row, input, tick, help, kind} — lifetime: app after first open
    helpOpen: new Set(),   // fields with prose expanded (view scratch)
  },
  archive: {  // shell built on first open; cards JIT + occlusion — lifetime: visibility
    root: grab('archive'), built: false,
    search: null, statusBtns: null, videoBtn: null, sortBtn: null, lineage: null,
    scroll: null, plane: null,
    map: new Map(),        // sessionId → card node — lifetime: visibility
    lastKey: '',           // filter+sessions signature for lineage rebuild
  },
  compare: {  // JIT on first compare, then permanent hidden
    root: grab('compare-root'), built: false,
    head: null, imgs: null, labels: null, scrub: null, locks: null,
    shown: ['', ''],
  },
  // wipe-recreate per open (keyed) — no selection state except encode's <video>
  inspector: { root: grab('inspector'), key: '' },
  sheet: { root: grab('sheet'), key: '', nodes: {} },
  help: { root: grab('help-drawer'), key: '' },
  toast: { root: grab('toast'), confirm: grab('confirm') },  // permanent, content projected
}

// ════════════════════════════════════════════════════════════════════════════
// § BOUNDARY VALIDATION — parse & validate at the edge, fail loud (engineering.md)
// ════════════════════════════════════════════════════════════════════════════

function req(obj, key, type, ctx) {
  const v = obj[key]
  if (type === 'array' ? !Array.isArray(v) : typeof v !== type) {
    throw new Error(`${ctx}: expected .${key} to be ${type}, got ${JSON.stringify(v)}`)
  }
  return v
}
function opt(obj, key, type, ctx) {
  const v = obj[key]
  if (v == null) return null
  return req(obj, key, type, ctx)
}

function validateSessionSummary(s) {
  const ctx = 'SessionSummary'
  req(s, 'id', 'string', ctx); req(s, 'state', 'string', ctx)
  req(s, 'frames', 'number', ctx); req(s, 'stepsDone', 'number', ctx); req(s, 'stepsTotal', 'number', ctx)
  req(s, 'artifacts', 'array', ctx)
  // live substates normalize to "rendering" at this boundary — summaries don't distinguish them
  if (['launching', 'loading_models', 'stopping'].includes(s.state)) s.state = 'rendering'
  const states = ['rendering', 'done', 'stopped', 'failed', 'queued', 'imported']
  if (!states.includes(s.state)) throw new Error(`${ctx}: unknown state ${JSON.stringify(s.state)}`)
  return s
}

function validateSchema(payload) {
  const fields = req(payload, 'fields', 'object', '/api/schema')
  req(payload, 'vqganModels', 'array', '/api/schema')
  const version = req(payload, 'configVersion', 'number', '/api/schema')
  if (version !== 2) throw new Error(`/api/schema configVersion ${version} — this client speaks version 2`)
  for (const [name, f] of Object.entries(fields)) {
    req(f, 'type', 'string', `schema field ${name}`)
    if (!['STR', 'PATH', 'WEIGHT', 'EXPR', 'NUM', 'BOOL', 'CHOICE', 'LIST'].includes(f.type)) {
      throw new Error(`schema field ${name}: unknown type badge ${JSON.stringify(f.type)}`)
    }
  }
  return payload
}

// SSE payloads — one validator per named event, throws on shape mismatch
function validateSse(type, data) {
  const ctx = `sse:${type}`
  switch (type) {
    case 'state': {
      req(data, 'sessionId', 'string', ctx)
      const st = req(data, 'state', 'string', ctx)
      if (!['launching', 'loading_models', 'rendering', 'stopping', 'done', 'stopped', 'failed'].includes(st)) {
        throw new Error(`${ctx}: unknown state ${JSON.stringify(st)}`)
      }
      return data
    }
    case 'progress':
      req(data, 'sessionId', 'string', ctx); req(data, 'step', 'number', ctx)
      req(data, 'stepsTotal', 'number', ctx); req(data, 'sPerStep', 'number', ctx)
      req(data, 'etaSec', 'number', ctx); req(data, 'elapsedSec', 'number', ctx)
      return data
    case 'frame':
      req(data, 'sessionId', 'string', ctx); req(data, 'index', 'number', ctx)
      req(data, 'url', 'string', ctx); req(data, 'thumbUrl', 'string', ctx); req(data, 'savedTotal', 'number', ctx)
      return data
    case 'log':
      req(data, 'sessionId', 'string', ctx); req(data, 'line', 'string', ctx); req(data, 'kind', 'string', ctx)
      return data
    case 'queue':
      if (data.queued != null) { req(data.queued, 'id', 'string', ctx); req(data.queued, 'slug', 'string', ctx) }
      return data
    case 'encode':
      req(data, 'jobId', 'string', ctx); req(data, 'sessionId', 'string', ctx)
      req(data, 'framesDone', 'number', ctx); req(data, 'framesTotal', 'number', ctx)
      req(data, 'state', 'string', ctx)
      return data
    default:
      throw new Error(`unknown SSE event type ${JSON.stringify(type)}`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § FETCH — validated, fail-loud. Async completions push events; tick mutates.
// ════════════════════════════════════════════════════════════════════════════

async function api(method, path, body) {
  const opts = { method }
  if (body !== undefined) {
    if (body instanceof FormData) { opts.body = body }
    else { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(body) }
  }
  const res = await fetch(path, opts)
  if (res.status === 204) return null
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON error body reported below */ }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    err.body = json
    throw err
  }
  if (json == null) throw new Error(`${method} ${path} → non-JSON 2xx body: ${text.slice(0, 120)}`)
  return json
}

function emit(ev) { state.events.push(ev); scheduleRender() }

function loadSessions() {
  api('GET', '/api/sessions').then((r) => {
    const list = req(r, 'sessions', 'array', '/api/sessions').map(validateSessionSummary)
    emit({ k: 'sessions', sessions: list })
  })
}

function loadDetail(id) {
  if (pendingDetails.has(id)) return
  pendingDetails.add(id)
  api('GET', `/api/sessions/${id}`)
    .finally(() => pendingDetails.delete(id))   // a failed fetch must not brick the session forever
    .then(
      (detail) => {
        validateSessionSummary(detail)
        req(detail, 'config', 'object', 'SessionDetail')
        emit({ k: 'detail', id, detail })
      },
      (err) => {
        emit({ k: 'detail-failed', id })
        throw err   // still surfaces as a danger toast via unhandledrejection
      })
}

function loadQueue() {
  api('GET', '/api/queue').then((r) => emit({ k: 'queue-state', queued: r.queued ?? null }))
}

function loadPresets() {
  api('GET', '/api/presets').then((r) => emit({ k: 'presets', presets: req(r, 'presets', 'array', '/api/presets') }))
}

function saveDraft() {
  api('PUT', '/api/draft', {
    values: state.draft.values, forkOf: state.draft.forkOf, seedLocked: state.draft.seedLocked,
  }).then(() => { /* 204; disk now equals screen */ })
}

function runPreflight() {
  api('POST', '/api/preflight', { values: state.draft.values }).then((r) => {
    req(r, 'issues', 'array', '/api/preflight')
    emit({ k: 'preflight', result: { ok: !!r.ok, issues: r.issues, estimate: r.estimate ?? null } })
  })
}

function postRun(mode) {
  api('POST', '/api/sessions', { mode }).then(
    (r) => emit({ k: 'run-result', mode, body: r }),
    (err) => {
      if (err.status === 409 && err.body != null) emit({ k: 'run-busy', live: err.body.live })
      else throw err
    })
}

function postStop(id) { api('POST', `/api/sessions/${id}/stop`).then(() => {}) }
function postResume(id) { api('POST', `/api/sessions/${id}/resume`).then(() => emit({ k: 'resumed' })) }
function deleteSession(id) { api('DELETE', `/api/sessions/${id}`).then(() => emit({ k: 'deleted', id })) }
function clearQueue() { api('DELETE', '/api/queue').then(() => emit({ k: 'queue-state', queued: null })) }

function postEncode(sessionId, fps, format, proxy) {
  api('POST', `/api/sessions/${sessionId}/encode`, { fps, format, proxy: !!proxy })
    .then((r) => emit({ k: 'encode-started', jobId: req(r, 'jobId', 'string', 'encode'), sessionId }))
}
function cancelEncode(jobId) { api('DELETE', `/api/encodes/${jobId}`).then(() => {}) }

function uploadFile(field, file) {
  const fd = new FormData()
  fd.append('file', file, file.name)
  api('POST', '/api/uploads', fd).then((r) => emit({ k: 'upload', field, path: req(r, 'path', 'string', '/api/uploads') }))
}

function loadBrowse(path) {
  api('GET', `/api/browse?path=${encodeURIComponent(path)}`)
    .then((r) => emit({ k: 'browse', path, entries: req(r, 'entries', 'array', '/api/browse') }))
}

function savePreset(name) {
  api('POST', '/api/presets', { name, values: state.draft.values }).then(() => loadPresets())
}

function postSystem(settings) {
  api('POST', '/api/system', settings).then(() => emit({ k: 'system-saved', settings }))
}
function deletePreset(name) { api('DELETE', `/api/presets/${encodeURIComponent(name)}`).then(() => loadPresets()) }

// Surface async failures loudly — a red toast plus the console error (no silencing)
window.addEventListener('unhandledrejection', (e) => {
  emit({ k: 'error', message: String(e.reason && e.reason.message || e.reason) })
})
window.addEventListener('error', (e) => {
  emit({ k: 'error', message: String(e.message) })
})

// ════════════════════════════════════════════════════════════════════════════
// § SSE CLIENT — native EventSource: auto-reconnect + Last-Event-ID replay
// ════════════════════════════════════════════════════════════════════════════

function openSse() {
  const es = new EventSource('/api/events')
  for (const type of ['state', 'progress', 'frame', 'log', 'queue', 'encode']) {
    es.addEventListener(type, (e) => emit({ k: 'sse', type, raw: e.data, id: e.lastEventId }))
  }
  es.onopen = () => emit({ k: 'sse-open' })
  es.onerror = () => emit({ k: 'sse-down' })
}

// ════════════════════════════════════════════════════════════════════════════
// § FRAME / URL DERIVATIONS
// ════════════════════════════════════════════════════════════════════════════

function frameUrl(id, n) { return `/api/sessions/${id}/frames/${n}` }
function thumbUrl(id, n) { return `/api/sessions/${id}/thumbs/${n}` }

function sessionFrames(s) {
  // live session's frame count can be ahead of the boot-scanned summary
  return s.id === state.live.sessionId ? Math.max(state.live.frames, s.frames) : s.frames
}

// what the Stage shows: explicit selection → live render → newest session → nothing
function stageSessionId() {
  if (state.sel.sessionId != null) return state.sel.sessionId
  if (state.live.sessionId != null) return state.live.sessionId
  return state.sessions.order.length > 0 ? state.sessions.order[0] : null
}

function sessionOf(id) {
  const s = state.sessions.byId[id]
  if (s == null) throw new Error(`unknown session ${id}`)
  return s
}

function authoredFps(s) {
  // authored fps needs the config snapshot; detail is fetched on selection
  return s.detail != null ? Number(s.detail.config.frames_per_second) : null
}

function nextSessionId() {
  let maxN = 0
  for (const id of state.sessions.order) {
    const m = /^s-(\d+)-/.exec(id)
    if (m) maxN = Math.max(maxN, Number(m[1]))
  }
  if (state.queue != null) {
    const m = /^s-(\d+)-/.exec(state.queue.id)
    if (m) maxN = Math.max(maxN, Number(m[1]))
  }
  const scenes = String(state.draft.values.scenes ?? '')
  const firstScene = scenes.split('||')[0]
  const firstPrompt = firstScene.split('|')[0].split(':')[0]
  return `s-${pad4(maxN + 1)}-${slugify(firstPrompt)}`
}

// ════════════════════════════════════════════════════════════════════════════
// § SCENES DSL — lexical tokenizer for DISPLAY ONLY (correctness comes solely
// from /api/preflight, which imports the engine's parser — never two grammars)
// ════════════════════════════════════════════════════════════════════════════

// Token colors (§8): pipes cyan, weights+negatives orange, masks+expressions purple,
// `||` a visible rule. Spans are color/background only — glyph metrics must match
// the textarea exactly, so no borders/padding on tokens.
function tokenizeScenes(text) {
  let html = ''
  let i = 0
  const n = text.length
  let plain = ''
  const flush = () => { if (plain !== '') { html += esc(plain); plain = '' } }
  while (i < n) {
    const c = text[i]
    if (c === '|') {
      flush()
      if (text[i + 1] === '|') { html += '<span class="t-rule">||</span>'; i += 2 }
      else { html += '<span class="t-pipe">|</span>'; i += 1 }
      continue
    }
    if (c === '_' && text[i + 1] === '[') {
      const close = text.indexOf(']', i)
      if (close >= 0) { flush(); html += `<span class="t-mask">${esc(text.slice(i, close + 1))}</span>`; i = close + 1; continue }
    }
    if (c === ':') {
      // weight run: everything up to the next | or : boundary; expressions stay purple
      let j = i + 1
      let depth = 0
      while (j < n) {
        const d = text[j]
        if (d === '(') depth++
        else if (d === ')') { if (depth === 0) break; depth-- }
        else if (depth === 0 && (d === '|' || d === ':' || d === '\n')) break
        j++
      }
      const w = text.slice(i + 1, j)
      if (w.trim() !== '') {
        flush()
        const cls = /[a-df-z(]/i.test(w) ? 't-expr' : (w.trim().startsWith('-') ? 't-neg' : 't-weight')
        html += `<span class="t-colon">:</span><span class="${cls}">${esc(w)}</span>`
        i = j
        continue
      }
    }
    plain += c
    i += 1
  }
  flush()
  return html + '\n' // trailing newline keeps overlay height in sync while typing at the end
}

// Display-only scene structure for the scene map strip
function parseScenesForMap(text) {
  const scenes = []
  for (const block of text.split('||')) {
    const prompts = block.split('|').map((p) => p.trim()).filter((p) => p !== '')
    let neg = 0
    for (const p of prompts) {
      const m = /:(-[\d.]+)/.exec(p)
      if (m) neg++
    }
    scenes.push({ label: (prompts[0] ?? '').split(':')[0].trim().slice(0, 24) || '(empty)', prompts: prompts.length, neg })
  }
  return scenes
}

// ════════════════════════════════════════════════════════════════════════════
// § EXPR PREVIEW — sandboxed numeric evaluation for sparklines (display only)
// ════════════════════════════════════════════════════════════════════════════

const EXPR_FUNCS = { sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, exp: Math.exp,
  log: Math.log, sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max, pow: Math.pow, pi: Math.PI, e: Math.E }

function audioBandNames() {
  const filters = state.draft.values.input_audio_filters
  if (!Array.isArray(filters)) return []
  return filters.map((f) => String(f.variable_name)).filter((v) => v !== '')
}

// returns a sampler f(t)→number|null, or null when the expression isn't previewable
function compileExpr(src) {
  const bands = audioBandNames()
  const names = ['t', ...Object.keys(EXPR_FUNCS), ...bands]
  const ok = /^[\d\s+\-*/%().,a-zA-Z_]*$/.test(src) && src.trim() !== ''
  if (!ok) return null
  const idents = src.match(/[a-zA-Z_][a-zA-Z_0-9]*/g) ?? []
  for (const id of idents) if (!names.includes(id)) return null
  try {
    const fn = new Function(...names, `"use strict"; return (${src});`)
    const funcVals = Object.values(EXPR_FUNCS)
    const bandZeros = bands.map(() => 0)  // bands preview as silence
    const sample = (t) => {
      const v = fn(t, ...funcVals, ...bandZeros)
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    if (sample(0) == null) return null
    return sample
  } catch { return null }
}

function drawSparkline(canvas, samples, color) {
  const ctx = canvas.getContext('2d')
  const dpr = devicePixelRatio || 1
  const w = canvas.width, h = canvas.height
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const vals = samples.filter((v) => v != null)
  if (vals.length < 2) return
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
  ctx.strokeStyle = color
  ctx.lineWidth = dpr
  ctx.beginPath()
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] == null) continue
    const x = (i / (samples.length - 1)) * (w - 2) + 1
    const y = h - 2 - ((samples[i] - lo) / (hi - lo)) * (h - 4)
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function plannedTMax() {
  const est = state.draft.preflight.estimate
  if (est != null && typeof est.videoSec === 'number' && est.videoSec > 0) return est.videoSec
  return 10
}

// ════════════════════════════════════════════════════════════════════════════
// § DERIVATIONS — clip presets, summaries, estimates, deltas
// ════════════════════════════════════════════════════════════════════════════

const CLIP_FIELDS = ['ViTB32', 'ViTB16', 'ViTL14', 'ViTL14_336px', 'RN50', 'RN101', 'RN50x4', 'RN50x16', 'RN50x64']
const CLIP_PRESETS = {
  DRAFT: ['ViTB32'],
  BALANCED: ['ViTB32', 'RN50x4'],
  RICH: ['ViTB32', 'RN50x4', 'ViTB16'],
}

function clipEnabled() { return CLIP_FIELDS.filter((f) => state.draft.values[f] === true) }

function clipPresetName() {
  const on = clipEnabled().sort().join(',')
  for (const [name, models] of Object.entries(CLIP_PRESETS)) {
    if ([...models].sort().join(',') === on) return name
  }
  return 'CUSTOM'
}

function fieldMeta(name) {
  const f = state.schema.fields[name]
  if (f == null) throw new Error(`no schema metadata for field ${name}`)
  return f
}

function isRelevant(name) {
  const meta = state.schema.fields[name]
  if (meta == null || meta.relevantWhen == null) return true
  const rw = meta.relevantWhen
  if (typeof rw.nonEmpty === 'string') {
    const v = state.draft.values[rw.nonEmpty]
    return typeof v === 'string' && v !== ''
  }
  if (typeof rw.field === 'string') {
    const actual = state.draft.values[rw.field]
    if (rw.equals !== undefined) return actual === rw.equals
    if (Array.isArray(rw.in)) return rw.in.includes(actual)
  }
  throw new Error(`field ${name}: unknown relevantWhen shape ${JSON.stringify(rw)}`)
}

function isModified(name) {
  const meta = state.schema.fields[name]
  if (meta == null) return false
  const v = state.draft.values[name]
  const d = meta.default
  if (Array.isArray(v) || Array.isArray(d)) return JSON.stringify(v ?? null) !== JSON.stringify(d ?? null)
  return (v ?? null) !== (d ?? null)
}

function coherenceLevel() {
  const raw = String(state.draft.values.direct_stabilization_weight ?? '').trim()
  if (raw === '' || raw === '0') return 'off'
  const v = Number(raw)
  if (!Number.isFinite(v)) return 'custom'
  if (v <= 0.15) return 'low'
  if (v <= 0.35) return 'med'
  return 'high'
}
const COHERENCE_WEIGHTS = { off: '', low: '0.1', med: '0.25', high: '0.5' }

function calibratedSPerStep() {
  const est = state.draft.preflight.estimate
  return est != null && typeof est.sPerStep === 'number' ? est.sPerStep : null
}

function benchSummaries() {
  const v = state.draft.values
  const modelAbbr = { 'Limited Palette': 'LP', 'Unlimited Palette': 'UP', 'VQGAN': 'VQ' }[v.image_model] ?? '?'
  const est = state.draft.preflight.estimate
  const sps = calibratedSPerStep()
  const canvas = `${modelAbbr}·${v.width}×${v.height}` + (v.image_model === 'Limited Palette' && Number(v.pixel_size) > 1 ? `·chunk${v.pixel_size}` : '')
  const time = est != null
    ? `${est.stepsTotal} st · ${est.frames} fr = ${Number(est.videoSec).toFixed(1)}s @ ${v.frames_per_second}fps`
    : `${v.steps_per_scene} st/scene @ ${v.frames_per_second}fps`
  const motionMode = v.animation_mode === 'off' ? 'off' : v.animation_mode === 'Video Source' ? 'VIDEO' : v.animation_mode
  return {
    prompt: '',
    canvas,
    startFrom: v.init_image ? basename(String(v.init_image)) + (v.breath_mode ? ' · breath' : '') : '(none)',
    motion: motionMode,
    coherence: coherenceLevel(),
    time,
    engine: `${clipEnabled().length} CLIP` + (sps != null ? ` · ${sps.toFixed(1)}s/st` : ''),
    audio: v.input_audio ? basename(String(v.input_audio)) : 'off',
  }
}

function estimateLine() {
  const pf = state.draft.preflight
  if (pf.estimate == null) return { text: 'EST ~calibrating', warn: false, hours: 0 }
  const e = pf.estimate
  const basis = e.basis === 'measured'
    ? `measured${e.basisSession ? ` (${e.basisSession})` : ''}`
    : '~calibrating'
  const hours = e.wallClockSec / 3600
  return {
    text: `EST ≈${fmtDur(e.wallClockSec)} · ${basis}` + (hours > 2 ? ' ⚠ >2h' : ''),
    warn: hours > 2, hours,
  }
}

function issuesBySection() {
  const by = {}
  for (const issue of state.draft.preflight.issues) {
    const key = issue.section ?? 'prompt'
    if (by[key] == null) by[key] = []
    by[key].push(issue)
  }
  return by
}

function configDiff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const diff = []
  for (const key of keys) {
    const av = a[key], bv = b[key]
    if (JSON.stringify(av ?? null) !== JSON.stringify(bv ?? null)) diff.push({ key, a: av, b: bv })
  }
  return diff
}

// ════════════════════════════════════════════════════════════════════════════
// § STARTERS — ghost drafts for the empty library (patches over schema defaults)
// ════════════════════════════════════════════════════════════════════════════

const STARTERS = [
  {
    title: 'LIMITED PALETTE', sub: 'portrait', est: '≈40 min',
    patch: { scenes: 'a luminous portrait, oil on canvas:2 | dramatic rim lighting | watermark:-1',
      image_model: 'Limited Palette', width: 384, height: 512, animation_mode: 'off',
      steps_per_scene: 400, steps_per_frame: 50, palette_size: 6, palettes: 16 },
  },
  {
    title: '2D DRIFT LOOP', sub: '≈1h 10m', est: '≈1h 10m',
    patch: { scenes: 'kelp cathedral, shafts of light:1.5 || bioluminescent reef, deep water',
      animation_mode: '2D', translate_x: '1', zoom_x_2d: '0.005', zoom_y_2d: '0.005',
      steps_per_scene: 600, steps_per_frame: 50, frames_per_second: 12, pre_animation_steps: 50 },
  },
  {
    title: 'VQGAN TEXTURE', sub: '≈40 min', est: '≈40 min',
    patch: { scenes: 'iridescent rust textures, macro photography, intricate detail',
      image_model: 'VQGAN', vqgan_model: 'imagenet', pixel_size: 1, animation_mode: 'off',
      steps_per_scene: 400, steps_per_frame: 50 },
  },
]

// ════════════════════════════════════════════════════════════════════════════
// § BENCH — generated once at boot from /api/schema (§7: permanent chunk)
// ════════════════════════════════════════════════════════════════════════════

const BENCH_SECTIONS = [
  ['prompt', 'PROMPT'], ['canvas', 'CANVAS'], ['startFrom', 'START FROM'], ['motion', 'MOTION'],
  ['coherence', 'COHERENCE'], ['time', 'TIME'], ['engine', 'ENGINE'], ['audio', 'AUDIO'],
]

// Fields whose bench widget is bespoke (generic type-badge widgets everywhere else)
const BESPOKE = new Set(['scenes', 'interpolation_steps', 'seed', 'image_model', 'vqgan_model',
  'width', 'height', 'pixel_size', 'palette_size', 'palettes', 'target_palette',
  'init_image', 'semantic_init_weight', 'breath_mode', 'direct_init_weight',
  'animation_mode', 'pre_animation_steps', 'lock_camera', 'direct_stabilization_weight',
  'input_audio_filters', ...CLIP_FIELDS])

const MOTION_PRESET_CHIPS = [
  { label: 'drift◄', writes: { translate_x: '-1', translate_y: '0' } },
  { label: 'drift►', writes: { translate_x: '1', translate_y: '0' } },
  { label: 'zoom+', writes: { zoom_x_2d: '0.01', zoom_y_2d: '0.01' } },
  { label: 'zoom−', writes: { zoom_x_2d: '-0.01', zoom_y_2d: '-0.01' } },
  { label: 'spiral', writes: { rotate_2d: 't/8', zoom_x_2d: '0.005', zoom_y_2d: '0.005' } },
  { label: 'sway', writes: { translate_x: '10*sin(t/4)' } },
]

const EXPR_PATTERN_CHIPS = [
  { label: 'const', text: '1' }, { label: 'sine', text: '10*sin(t/4)' }, { label: 'ramp', text: 't/10' },
]

// generic widget factory — one per type badge; returns a record for domCache.bench.widgets
function makeWidget(name, meta, home) {
  const row = el('div', 'field-row')
  row.dataset.fieldRow = name
  const label = el('label', 'field-label', meta.label ?? name)
  label.htmlFor = `${home}-${name}`
  const badge = el('span', 'type-badge', meta.type)
  const wrap = el('span', 'field-wrap')
  let input
  let kind = meta.type
  switch (meta.type) {
    case 'BOOL':
      input = el('input')
      input.type = 'checkbox'
      break
    case 'NUM': case 'WEIGHT':
      input = el('input', 'in-num')
      input.type = 'number'
      input.step = meta.type === 'WEIGHT' ? '0.05' : 'any'
      break
    case 'CHOICE': {
      input = el('select', 'in-choice')
      const choices = meta.choices
      if (!Array.isArray(choices)) throw new Error(`CHOICE field ${name} has no choices[]`)
      for (const c of choices) {
        const o = el('option', '', String(c))
        o.value = String(c)
        input.appendChild(o)
      }
      break
    }
    case 'EXPR':
      input = el('input', 'in-expr')
      input.type = 'text'
      input.spellcheck = false
      break
    case 'LIST':
      // generic LIST fallback: one JSON row per line (input_audio_filters is bespoke)
      input = el('textarea', 'in-list')
      input.rows = 2
      kind = 'LIST'
      break
    default:  // STR, PATH
      input = el('input', meta.type === 'PATH' ? 'in-path' : 'in-str')
      input.type = 'text'
      input.spellcheck = false
  }
  input.id = `${home}-${name}`
  input.dataset.field = name
  wrap.appendChild(input)
  const rec = { kind, row, input, name, spark: null, browse: null }
  if (meta.type === 'PATH') {
    const browse = el('button', 'btn tiny', '📁')
    browse.dataset.ev = 'browse-open'
    browse.dataset.field = name
    wrap.appendChild(browse)
    row.classList.add('drop-well-row')
    row.dataset.dropField = name
    rec.browse = browse
  }
  if (meta.type === 'EXPR') {
    const spark = el('canvas', 'expr-spark')
    spark.width = 90; spark.height = 18
    wrap.appendChild(spark)
    rec.spark = spark
    const chips = el('span', 'chips')
    for (const c of EXPR_PATTERN_CHIPS) {
      const chip = el('button', 'btn chip', c.label)
      chip.dataset.ev = 'expr-chip'; chip.dataset.field = name; chip.dataset.text = c.text
      chips.appendChild(chip)
    }
    rec.chips = chips
    row.appendChild(label); row.appendChild(badge); row.appendChild(wrap); row.appendChild(chips)
  } else {
    row.appendChild(label); row.appendChild(badge); row.appendChild(wrap)
  }
  if (meta.hint) {
    const hint = el('div', 'field-hint', meta.hint)
    row.appendChild(hint)
  }
  return rec
}

function benchSectionKeyOf(name) {
  const meta = state.schema.fields[name]
  return meta != null && typeof meta.section === 'string' ? meta.section : null
}

function buildBench() {
  const dc = domCache.bench
  const frag = document.createDocumentFragment()
  for (const [key, title] of BENCH_SECTIONS) {
    const root = el('section', 'bench-sec')
    const head = el('div', 'bench-sec-head')
    head.dataset.ev = 'bench-toggle'
    head.dataset.section = key
    const arrow = el('span', 'sec-arrow', '▸')
    const titleEl = el('span', 'sec-title', title)
    const badge = el('span', 'sec-badge', '')
    const summary = el('span', 'sec-summary', '')
    head.appendChild(arrow); head.appendChild(titleEl); head.appendChild(badge); head.appendChild(summary)
    const body = el('div', 'bench-sec-body')
    root.appendChild(head); root.appendChild(body)
    frag.appendChild(root)
    dc.sec[key] = { root, head, arrow, badge, summary, body }
  }

  // ── PROMPT: scenes textarea + overlay + scene map strip + cheat strip ──
  {
    const body = dc.sec.prompt.body
    const editor = el('div', 'scenes-editor')
    const overlay = el('pre', 'scenes-overlay')
    overlay.setAttribute('aria-hidden', 'true')
    const ta = el('textarea', 'scenes-ta')
    ta.id = 'f-scenes'; ta.dataset.field = 'scenes'; ta.rows = 6; ta.spellcheck = false
    ta.placeholder = '(empty — pick a starter or type)\nkelp cathedral:2 | shafts of light || bioluminescent reef:1.5'
    editor.appendChild(overlay); editor.appendChild(ta)
    body.appendChild(editor)
    const mapStrip = el('div', 'scene-map')
    body.appendChild(mapStrip)
    const cheat = el('div', 'cheat-strip')
    for (const [tok, tip] of [['|', 'prompt separator'], ['||', 'scene break'], [':w', 'weight'], [':-1', 'negative'], ['_[m]', 'mask'], ['?', 'help']]) {
      const b = el('button', 'btn chip', tok)
      if (tok === '?') { b.dataset.ev = 'open-help' } else { b.dataset.ev = 'insert-token'; b.dataset.text = tok === ':w' ? ':1' : tok === '_[m]' ? '_[mask.png]' : tok }
      b.title = tip
      cheat.appendChild(b)
    }
    body.appendChild(cheat)
    // STYLE / AVOID rows (scene_prefix / scene_suffix), generic STR widgets relabeled
    for (const [name, lbl] of [['scene_prefix', 'STYLE'], ['scene_suffix', 'AVOID']]) {
      const meta = { ...fieldMeta(name), label: lbl }
      const w = makeWidget(name, meta, 'f')
      dc.widgets.set(name, w)
      body.appendChild(w.row)
    }
    dc.scenes = { ta, overlay, lastHtml: '', mapStrip, lastMapKey: '' }
  }

  // ── CANVAS: image model cards, size presets, LP/VQGAN sub-panels ──
  {
    const body = dc.sec.canvas.body
    const cards = el('div', 'model-cards')
    const looks = {
      'Limited Palette': 'poster-flat, dithered, graphic',
      'Unlimited Palette': 'painterly, smooth gradients',
      'VQGAN': 'photographic texture, sharp detail',
    }
    const cardMap = {}
    for (const model of ['Limited Palette', 'Unlimited Palette', 'VQGAN']) {
      const card = el('button', 'model-card')
      card.dataset.ev = 'set-field'; card.dataset.field = 'image_model'; card.dataset.value = model
      card.appendChild(el('div', 'mc-name', model.replace(' Palette', '').toUpperCase() + (model.includes('Palette') ? ' PALETTE' : '')))
      card.appendChild(el('div', 'mc-look', looks[model]))
      card.appendChild(el('div', 'mc-cost', ''))
      cards.appendChild(card)
      cardMap[model] = card
    }
    body.appendChild(cards)
    dc.modelCards = cardMap

    const sizes = el('div', 'size-row')
    for (const [px, mult] of [[256, '×1'], [384, '×~2.3'], [512, '×~4.5']]) {
      const b = el('button', 'btn chip', `${px} ${mult}`)
      b.dataset.ev = 'size-preset'; b.dataset.px = String(px)
      sizes.appendChild(b)
    }
    for (const [lbl, w, h] of [['1:1', 1, 1], ['3:4', 3, 4], ['4:3', 4, 3], ['16:9', 16, 9]]) {
      const b = el('button', 'btn chip', lbl)
      b.dataset.ev = 'aspect-preset'; b.dataset.w = String(w); b.dataset.h = String(h)
      sizes.appendChild(b)
    }
    body.appendChild(sizes)
    for (const name of ['width', 'height']) {
      const w = makeWidget(name, fieldMeta(name), 'f')
      dc.widgets.set(name, w)
      body.appendChild(w.row)
    }
    const matchInit = el('button', 'btn chip', 'set −1 = match init')
    matchInit.dataset.ev = 'size-match-init'
    matchInit.id = 'size-match-init'
    body.appendChild(matchInit)
    dc.matchInit = matchInit

    // VQGAN sub-panel: picker generated from schema.vqganModels (all real entries; sflckr alias never shown)
    const vq = el('div', 'sub-panel')
    vq.id = 'vq-panel'
    const vqSel = el('select', 'in-choice')
    vqSel.dataset.field = 'vqgan_model'; vqSel.id = 'f-vqgan_model'
    for (const m of state.schema.vqganModels) {
      const o = el('option', '', m); o.value = m
      vqSel.appendChild(o)
    }
    const vqRow = el('div', 'field-row')
    const vqLbl = el('label', 'field-label', 'checkpoint'); vqLbl.htmlFor = 'f-vqgan_model'
    vqRow.appendChild(vqLbl); vqRow.appendChild(el('span', 'type-badge', 'CHOICE'))
    const vqWrap = el('span', 'field-wrap'); vqWrap.appendChild(vqSel); vqRow.appendChild(vqWrap)
    vq.appendChild(vqRow)
    vq.appendChild(el('div', 'field-hint', 'pixel chunk auto-forced to 1 under VQGAN'))
    body.appendChild(vq)
    dc.widgets.set('vqgan_model', { kind: 'CHOICE', row: vqRow, input: vqSel, name: 'vqgan_model', spark: null })
    dc.vqPanel = vq

    // Limited Palette sub-panel: chunk stepper + palette sliders + target palette
    const lp = el('div', 'sub-panel')
    lp.id = 'lp-panel'
    for (const name of ['pixel_size', 'palette_size', 'palettes']) {
      const meta = { ...fieldMeta(name), label: name === 'pixel_size' ? 'chunk' : fieldMeta(name).label ?? name }
      const w = makeWidget(name, meta, 'f')
      dc.widgets.set(name, w)
      lp.appendChild(w.row)
    }
    const totalColors = el('div', 'derived-row', '')
    lp.appendChild(totalColors)
    dc.totalColors = totalColors
    const tp = makeWidget('target_palette', fieldMeta('target_palette'), 'f')
    dc.widgets.set('target_palette', tp)
    const swatch = el('img', 'palette-swatch')
    swatch.alt = ''
    tp.row.appendChild(swatch)
    dc.paletteSwatch = swatch
    lp.appendChild(tp.row)
    body.appendChild(lp)
    dc.lpPanel = lp
  }

  // ── START FROM: init drop-well; breath toggle lives INSIDE the well ──
  {
    const body = dc.sec.startFrom.body
    const well = el('div', 'init-well')
    well.dataset.dropField = 'init_image'
    const thumb = el('img', 'init-thumb'); thumb.alt = ''
    const initIn = el('input', 'in-path')
    initIn.type = 'text'; initIn.dataset.field = 'init_image'; initIn.id = 'f-init_image'
    initIn.placeholder = 'drop an image here, or paste a path'
    initIn.spellcheck = false
    const initBrowse = el('button', 'btn tiny', '📁')
    initBrowse.dataset.ev = 'browse-open'; initBrowse.dataset.field = 'init_image'
    const initRow = el('div', 'well-row')
    initRow.appendChild(initIn); initRow.appendChild(initBrowse)
    well.appendChild(thumb); well.appendChild(initRow)
    dc.widgets.set('init_image', { kind: 'PATH', row: well, input: initIn, name: 'init_image', spark: null })
    dc.initThumb = thumb

    const semantic = makeWidget('semantic_init_weight', { ...fieldMeta('semantic_init_weight'), label: 'hold on to it' }, 'f')
    dc.widgets.set('semantic_init_weight', semantic)
    well.appendChild(semantic.row)

    const breathRow = el('div', 'field-row')
    const breathIn = el('input'); breathIn.type = 'checkbox'; breathIn.dataset.field = 'breath_mode'; breathIn.id = 'f-breath_mode'
    const breathLbl = el('label', 'field-label', 'breath mode'); breathLbl.htmlFor = 'f-breath_mode'
    breathRow.appendChild(breathLbl); breathRow.appendChild(el('span', 'type-badge', 'BOOL'))
    const bwrap = el('span', 'field-wrap'); bwrap.appendChild(breathIn); breathRow.appendChild(bwrap)
    well.appendChild(breathRow)
    dc.widgets.set('breath_mode', { kind: 'BOOL', row: breathRow, input: breathIn, name: 'breath_mode', spark: null })

    const direct = makeWidget('direct_init_weight', fieldMeta('direct_init_weight'), 'f')
    direct.row.appendChild(el('div', 'field-hint warn-hint', '⚠ underscores in init filenames read as mask syntax — rename if weighting misparses'))
    dc.widgets.set('direct_init_weight', direct)
    well.appendChild(direct.row)
    body.appendChild(well)
    dc.initWell = well
  }

  // ── MOTION: mode segments, preset chips, per-mode EXPR fields ──
  {
    const body = dc.sec.motion.body
    const seg = el('div', 'mode-seg')
    for (const [value, lbl] of [['off', 'OFF'], ['2D', '2D'], ['3D', '3D'], ['Video Source', 'VIDEO']]) {
      const b = el('button', 'btn seg', lbl)
      b.dataset.ev = 'set-field'; b.dataset.field = 'animation_mode'; b.dataset.value = value
      seg.appendChild(b)
    }
    body.appendChild(seg)
    dc.modeSeg = seg
    const parked = el('div', 'parked-note', 'PARKED — unverified on Mac')
    body.appendChild(parked)
    dc.parkedNote = parked

    const chips = el('div', 'chips motion-chips')
    for (const c of MOTION_PRESET_CHIPS) {
      const b = el('button', 'btn chip', c.label)
      b.dataset.ev = 'motion-chip'; b.dataset.writes = JSON.stringify(c.writes)
      chips.appendChild(b)
    }
    body.appendChild(chips)
    dc.motionChips = chips

    const pane2d = el('div', 'sub-panel'); pane2d.id = 'pane-2d'
    for (const name of ['translate_x', 'translate_y', 'rotate_2d', 'zoom_x_2d', 'zoom_y_2d']) {
      const w = makeWidget(name, fieldMeta(name), 'f')
      dc.widgets.set(name, w)
      pane2d.appendChild(w.row)
    }
    body.appendChild(pane2d)
    dc.pane2d = pane2d

    const pane3d = el('div', 'sub-panel parked'); pane3d.id = 'pane-3d'
    for (const name of ['translate_z_3d', 'rotate_3d', 'field_of_view']) {
      const w = makeWidget(name, fieldMeta(name), 'f')
      dc.widgets.set(name, w)
      pane3d.appendChild(w.row)
    }
    body.appendChild(pane3d)
    dc.pane3d = pane3d

    const paneVid = el('div', 'sub-panel'); paneVid.id = 'pane-video'
    for (const name of ['video_path', 'frame_stride']) {
      const w = makeWidget(name, fieldMeta(name), 'f')
      dc.widgets.set(name, w)
      paneVid.appendChild(w.row)
    }
    const strideNote = el('div', 'derived-row', '')
    paneVid.appendChild(strideNote)
    dc.strideNote = strideNote
    const vidProbe = el('div', 'derived-row', '')
    paneVid.appendChild(vidProbe)
    dc.vidProbe = vidProbe
    body.appendChild(paneVid)
    dc.paneVid = paneVid

    // DEVELOP FIRST: pre_animation_steps + lock_camera, one combined control
    const dev = el('div', 'field-row'); dev.id = 'develop-first'
    const devLbl = el('label', 'field-label', 'DEVELOP FIRST'); devLbl.htmlFor = 'f-pre_animation_steps'
    const devIn = el('input', 'in-num'); devIn.type = 'number'; devIn.dataset.field = 'pre_animation_steps'; devIn.id = 'f-pre_animation_steps'
    const devLock = el('input'); devLock.type = 'checkbox'; devLock.dataset.field = 'lock_camera'; devLock.id = 'f-lock_camera'; devLock.title = 'lock camera during develop'
    const devWrap = el('span', 'field-wrap')
    devWrap.appendChild(devIn); devWrap.appendChild(el('span', 'dim', ' st ')); devWrap.appendChild(devLock); devWrap.appendChild(el('span', 'dim', '🔒'))
    dev.appendChild(devLbl); dev.appendChild(el('span', 'type-badge', 'NUM')); dev.appendChild(devWrap)
    body.appendChild(dev)
    dc.developFirst = dev
    dc.widgets.set('pre_animation_steps', { kind: 'NUM', row: dev, input: devIn, name: 'pre_animation_steps', spark: null })
    dc.widgets.set('lock_camera', { kind: 'BOOL', row: dev, input: devLock, name: 'lock_camera', spark: null })
  }

  // ── COHERENCE: flicker↔ghosting macro dial + flow weight ──
  {
    const body = dc.sec.coherence.body
    const dial = el('div', 'field-row')
    dial.appendChild(el('label', 'field-label', 'flicker ↔ ghosting'))
    const wrap = el('span', 'field-wrap chips')
    for (const level of ['off', 'low', 'med', 'high']) {
      const b = el('button', 'btn chip', level)
      b.dataset.ev = 'coherence-level'; b.dataset.level = level
      wrap.appendChild(b)
    }
    dial.appendChild(el('span', 'type-badge', 'WEIGHT'))
    dial.appendChild(wrap)
    body.appendChild(dial)
    dc.coherenceDial = wrap
    const flow = makeWidget('flow_stabilization_weight', fieldMeta('flow_stabilization_weight'), 'f')
    dc.widgets.set('flow_stabilization_weight', flow)
    body.appendChild(flow.row)
    dc.flowRow = flow.row
  }

  // ── TIME: engine-named inputs + one-way derived readouts ──
  {
    const body = dc.sec.time.body
    for (const name of ['steps_per_scene', 'steps_per_frame', 'frames_per_second']) {
      const meta = { ...fieldMeta(name) }
      if (name === 'frames_per_second') meta.hint = 'playback fps — also the time-scale of t in motion expressions'
      const w = makeWidget(name, meta, 'f')
      dc.widgets.set(name, w)
      body.appendChild(w.row)
    }
    const readout = el('div', 'derived-row time-readout', '')
    body.appendChild(readout)
    dc.timeReadout = readout
  }

  // ── ENGINE: costed CLIP presets (raw checkboxes live in the engine room) ──
  {
    const body = dc.sec.engine.body
    const chips = el('div', 'chips')
    for (const name of ['DRAFT', 'BALANCED', 'RICH']) {
      const b = el('button', 'btn chip', name)
      b.dataset.ev = 'clip-preset'; b.dataset.preset = name
      chips.appendChild(b)
    }
    body.appendChild(chips)
    dc.clipChips = chips
    const detail = el('div', 'derived-row', '')
    body.appendChild(detail)
    dc.clipDetail = detail
    const openEr = el('button', 'btn', 'ENGINE ROOM (E) — raw checkboxes + every field')
    openEr.dataset.ev = 'open-engine'
    body.appendChild(openEr)
  }

  // ── AUDIO: input picker + offset + band table ──
  {
    const body = dc.sec.audio.body
    for (const name of ['input_audio', 'input_audio_offset']) {
      const w = makeWidget(name, fieldMeta(name), 'f')
      dc.widgets.set(name, w)
      body.appendChild(w.row)
    }
    const table = el('div', 'band-table')
    body.appendChild(table)
    dc.bandTable = table
    const add = el('button', 'btn chip', '+ band')
    add.dataset.ev = 'band-add'
    body.appendChild(add)
    dc.bandAdd = add
  }

  // ── everything else the schema puts in a bench section, generically ──
  for (const [name, meta] of Object.entries(state.schema.fields)) {
    if (BESPOKE.has(name) || dc.widgets.has(name)) continue
    const key = benchSectionKeyOf(name)
    if (key == null || dc.sec[key] == null) continue
    const w = makeWidget(name, meta, 'f')
    dc.widgets.set(name, w)
    dc.sec[key].body.appendChild(w.row)
  }

  dc.sections.appendChild(frag)
  dc.built = true
}

// ════════════════════════════════════════════════════════════════════════════
// § ENGINE ROOM — JIT built on first open from schema, then permanent (§7)
// ════════════════════════════════════════════════════════════════════════════

const ER_GROUP_ORDER = ['SEEING', 'SEEDING', 'MEDIUM', 'CAMERA', 'COHERENCE', 'TIME', 'OPTIMIZER', 'AUDIO', 'FILES', 'SYSTEM']
const ER_HIDDEN = new Set(['display_every', 'restore', 'config_version'])   // capability kept server-side, no UI (§4.3)
const ER_READONLY = new Set(['file_namespace', 'allow_overwrite', 'device', 'models_parent_dir', 'approximate_vram_usage'])

function buildEngineRoom() {
  const dc = domCache.engineRoom
  const root = dc.root
  const head = el('div', 'er-head scanlines')
  const search = el('input', 'er-search')
  search.type = 'text'; search.placeholder = '⌕ search fields + help…'; search.dataset.ui = 'er-search'
  const count = el('span', 'er-count', '')
  const reset = el('button', 'btn', 'reset all')
  reset.dataset.ev = 'er-reset'
  const close = el('button', 'btn', 'esc')
  close.dataset.ev = 'close-engine'
  head.appendChild(el('span', 'er-title', 'ENGINE ROOM'))
  head.appendChild(search); head.appendChild(count); head.appendChild(reset); head.appendChild(close)
  root.appendChild(head)

  const body = el('div', 'er-body')
  const nav = el('nav', 'er-nav')
  const fields = el('div', 'er-fields')
  body.appendChild(nav); body.appendChild(fields)
  root.appendChild(body)

  // group fields by schema `group`, ordered by the §3.5 rail
  const byGroup = new Map()
  for (const [name, meta] of Object.entries(state.schema.fields)) {
    if (ER_HIDDEN.has(name)) continue
    const g = typeof meta.group === 'string' ? meta.group.toUpperCase() : 'SYSTEM'
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(name)
  }
  const order = [...ER_GROUP_ORDER.filter((g) => byGroup.has(g)), ...[...byGroup.keys()].filter((g) => !ER_GROUP_ORDER.includes(g))]

  for (const groupName of order) {
    const navBtn = el('button', 'er-nav-btn', groupName)
    navBtn.dataset.ev = 'er-nav'; navBtn.dataset.group = groupName
    nav.appendChild(navBtn)

    const groupRoot = el('div', 'er-group')
    groupRoot.dataset.erGroup = groupName
    const groupHead = el('div', 'er-group-head', groupName)
    const inactive = el('button', 'er-inactive', '')
    inactive.dataset.ev = 'er-force'; inactive.dataset.group = groupName
    const groupBody = el('div', 'er-group-body')
    groupRoot.appendChild(groupHead); groupRoot.appendChild(inactive); groupRoot.appendChild(groupBody)
    fields.appendChild(groupRoot)
    dc.groups.set(groupName, { root: groupRoot, head: groupHead, inactive, body: groupBody, navBtn })

    for (const name of byGroup.get(groupName)) {
      const meta = fieldMeta(name)
      const w = makeWidget(name, meta, 'er')
      const row = w.row
      row.classList.add('er-row')
      const tick = el('span', 'mod-tick', '◆')      // cyan = modified-from-default
      row.insertBefore(tick, row.firstChild)
      if (meta.costNote) row.appendChild(el('span', 'cost-note', meta.costNote))
      let prose = null
      if (meta.prose) {
        const helpBtn = el('button', 'btn tiny', '?')
        helpBtn.dataset.ev = 'er-help'; helpBtn.dataset.field = name
        row.appendChild(helpBtn)
        prose = el('div', 'er-prose', meta.prose)
        row.appendChild(prose)
      }
      if (ER_READONLY.has(name)) {
        w.input.disabled = true
        row.classList.add('readonly')
      }
      let note = null
      if (name === 'gradient_accumulation_steps' || name === 'save_every') {
        note = el('span', 'derived-note', '')
        row.appendChild(note)
      }
      groupBody.appendChild(row)
      dc.rows.set(name, { ...w, modTick: tick, prose, note, group: groupName, searchText: `${name} ${meta.label ?? ''} ${meta.hint ?? ''} ${meta.prose ?? ''}`.toLowerCase() })
    }
  }
  dc.search = search
  dc.count = count
  dc.nav = nav
  dc.forceOpen = new Set()
  dc.built = true
}

// ════════════════════════════════════════════════════════════════════════════
// § ARCHIVE — shell on first open; cards JIT + occlusion (§7)
// ════════════════════════════════════════════════════════════════════════════

function buildArchive() {
  const dc = domCache.archive
  const head = el('div', 'arch-head scanlines')
  head.appendChild(el('span', 'arch-title', 'ARCHIVE'))
  const search = el('input', 'arch-search')
  search.type = 'text'; search.placeholder = 'search prompts… ⌕'; search.dataset.ui = 'arch-search'
  head.appendChild(search)
  const statusBtns = el('span', 'chips')
  for (const s of ['all', 'done', 'stopped', 'failed']) {
    const b = el('button', 'btn chip', s)
    b.dataset.ev = 'arch-status'; b.dataset.status = s
    statusBtns.appendChild(b)
  }
  head.appendChild(statusBtns)
  const videoBtn = el('button', 'btn chip', 'has-video')
  videoBtn.dataset.ev = 'arch-video'
  head.appendChild(videoBtn)
  const sortBtn = el('button', 'btn chip', 'newest▾')
  sortBtn.dataset.ev = 'arch-sort'
  head.appendChild(sortBtn)
  const close = el('button', 'btn', 'esc')
  close.dataset.ev = 'close-archive'
  head.appendChild(close)
  dc.root.appendChild(head)

  const lineage = el('div', 'arch-lineage')
  dc.root.appendChild(lineage)
  const scroll = el('div', 'arch-scroll')
  const plane = el('div', 'arch-plane')
  scroll.appendChild(plane)
  dc.root.appendChild(scroll)
  dc.search = search; dc.statusBtns = statusBtns; dc.videoBtn = videoBtn; dc.sortBtn = sortBtn
  dc.lineage = lineage; dc.scroll = scroll; dc.plane = plane
  dc.built = true
}

function archiveFiltered() {
  const f = state.ui.archiveFilter
  const out = []
  for (const id of state.sessions.order) {
    const s = state.sessions.byId[id]
    if (f.status !== 'all' && s.state !== f.status) continue
    if (f.hasVideo && s.artifacts.length === 0) continue
    // SessionSummary carries no prompt text — id/slug/delta is the searchable surface
    const haystack = `${id} ${s.slug ?? ''} ${s.deltaSummary ?? ''}`.toLowerCase()
    if (f.text !== '' && !haystack.includes(f.text.toLowerCase())) continue
    out.push(s)
  }
  return out
}

// fork-families as rows, oldest→newest, for the lineage view
function lineageFamilies() {
  const children = new Map()
  const roots = []
  for (const id of state.sessions.order) {
    const s = state.sessions.byId[id]
    const parent = s.forkedFrom
    if (parent != null && state.sessions.byId[parent] != null) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(id)
    } else roots.push(id)
  }
  const families = []
  for (const root of roots.slice().reverse()) {   // oldest → newest
    const chain = []
    const walk = (id, depth) => {
      chain.push({ id, depth })
      for (const c of (children.get(id) ?? []).slice().reverse()) walk(c, depth + 1)
    }
    walk(root, 0)
    if (chain.length > 1) families.push(chain)
  }
  return families
}

// ════════════════════════════════════════════════════════════════════════════
// § COMPARE — JIT on first compare, then permanent hidden (§7)
// ════════════════════════════════════════════════════════════════════════════

function buildCompare() {
  const dc = domCache.compare
  const head = el('div', 'cmp-head')
  const title = el('span', 'cmp-title', '')
  const delta = el('button', 'btn chip', '')
  delta.dataset.ev = 'cmp-diff'
  const close = el('button', 'btn', 'esc')
  close.dataset.ev = 'compare-exit'
  head.appendChild(title); head.appendChild(delta); head.appendChild(close)
  const panes = el('div', 'cmp-panes')
  const imgs = []
  const labels = []
  const locks = []
  for (const side of ['a', 'b']) {
    const pane = el('div', 'cmp-pane')
    const img = el('img', 'cmp-img'); img.alt = ''; img.draggable = false
    const label = el('div', 'cmp-label', '')
    const lock = el('button', 'btn tiny', '🔒')
    lock.dataset.ev = 'compare-lock'; lock.dataset.side = side
    pane.appendChild(img); pane.appendChild(label); pane.appendChild(lock)
    panes.appendChild(pane)
    imgs.push(img); labels.push(label); locks.push(lock)
  }
  const scrubRow = el('div', 'cmp-scrub-row')
  scrubRow.appendChild(el('span', 'lbl', 'SCRUB (aligned by STEP №)'))
  const scrub = el('input', 'cmp-scrub')
  scrub.type = 'range'; scrub.min = '0'; scrub.dataset.ui = 'compare-scrub'
  scrubRow.appendChild(scrub)
  dc.root.appendChild(head); dc.root.appendChild(panes); dc.root.appendChild(scrubRow)
  dc.head = title; dc.delta = delta; dc.imgs = imgs; dc.labels = labels; dc.scrub = scrub; dc.locks = locks
  dc.built = true
}

function compareSides() {
  const aId = state.sel.sessionId
  const cmp = state.sel.compare
  if (aId == null || cmp == null) throw new Error('compareSides called outside compare mode')
  return [sessionOf(aId), sessionOf(cmp.otherId)]
}

function stepsPerFrame(s) {
  const frames = sessionFrames(s)
  const steps = s.id === state.live.sessionId ? state.live.step : s.stepsDone
  return frames > 0 ? Math.max(1, steps / frames) : 1
}

// ════════════════════════════════════════════════════════════════════════════
// § ACTION HELPERS (called from tick — state mutation + fetch side effects)
// ════════════════════════════════════════════════════════════════════════════

let lastFocusedField = 'scenes'   // click-insert target (plumbing, not app state)
let pendingFork = null            // session id whose detail fetch will complete a fork
let helpSearch = ''               // help drawer settings-table filter (view scratch)
const dropPreviews = new Map()    // field → {objUrl, path, durationSec} — local preview for dropped files

function schemaDefaults() {
  const out = {}
  for (const [name, meta] of Object.entries(state.schema.fields)) out[name] = meta.default ?? null
  return out
}

function markEdited(name) {
  const d = state.draft
  d.dirtySinceRun = true
  clearTimeout(d.saveTimer)
  d.saveTimer = setTimeout(() => emit({ k: 'timer', which: 'save' }), 400)
  clearTimeout(timers.preflight)
  timers.preflight = setTimeout(() => emit({ k: 'timer', which: 'preflight' }), 600)
  state.dirty.bench = true
  state.dirty.runBar = true
  state.dirty.engine = true
  if (name === 'scenes' || name === 'interpolation_steps') state.dirty.sceneMap = true
}

function setField(name, raw) {
  const meta = fieldMeta(name)
  let v
  switch (meta.type) {
    case 'NUM': case 'WEIGHT': {
      if (raw === '' || raw === null) { v = null; break }
      const n = Number(raw)
      if (!Number.isFinite(n)) return   // mid-typing garbage; input still holds the text
      v = n
      break
    }
    case 'BOOL': v = raw === true || raw === 'true'; break
    case 'LIST': v = Array.isArray(raw) ? raw : state.draft.values[name]; break
    default: v = String(raw)
  }
  state.draft.values[name] = v
  markEdited(name)
}

function setFields(patch) { for (const [k, v] of Object.entries(patch)) setField(k, v) }

function applyClipPreset(name) {
  const models = CLIP_PRESETS[name]
  if (models == null) throw new Error(`unknown CLIP preset ${name}`)
  for (const f of CLIP_FIELDS) setField(f, models.includes(f))
}

function applyStarter(idx) {
  const starter = STARTERS[idx]
  if (starter == null) throw new Error(`no starter ${idx}`)
  state.draft.values = { ...schemaDefaults(), ...starter.patch }
  state.draft.forkOf = null
  state.draft.seedLocked = false
  markEdited('scenes')
  state.dirty.sceneMap = true
  state.ui.benchSections.prompt = true
  fx.focusField = 'scenes'
}

function applyFork(id) {
  const s = sessionOf(id)
  if (s.detail == null) { pendingFork = id; loadDetail(id); return }
  const config = s.detail.config
  const values = {}
  for (const name of Object.keys(state.schema.fields)) {
    values[name] = config[name] !== undefined ? config[name] : (fieldMeta(name).default ?? null)
  }
  state.draft.values = values
  state.draft.forkOf = id
  state.draft.seedLocked = true      // exact reproduction is the default; the die is the explicit act
  markEdited('scenes')
  state.dirty.sceneMap = true
  state.ui.benchSections.prompt = true
  fx.focusField = 'scenes'
  toast(`⑂ forked ${id} — seed locked`, [])
}

function toast(text, actions, ms = 6000) {
  state.ui.toast = { text, actions, expiresAt: state.now + ms }
  state.dirty.toast = true
}

function selectSession(id, shiftKey) {
  if (shiftKey && stageSessionId() != null && stageSessionId() !== id) {
    state.sel.sessionId = stageSessionId()
    state.sel.compare = { otherId: id, locked: true, stepOffset: 0, focus: 'a' }
    state.sel.playing = false
    loadDetail(state.sel.sessionId); loadDetail(id)
    state.dirty.compare = true
    return
  }
  state.sel.sessionId = id === state.live.sessionId ? null : id
  state.sel.frameIdx = null
  state.sel.playing = false
  state.sel.compare = null
  state.ui.archiveOpen = false
  loadDetail(id)
  state.dirty.stage = true; state.dirty.filmstrip = true; state.dirty.library = true
}

function startCompare(id) {
  if (id == null) return
  const parent = sessionOf(id).forkedFrom
  if (parent != null && state.sessions.byId[parent] != null) {
    state.sel.sessionId = id
    state.sel.compare = { otherId: parent, locked: true, stepOffset: 0, focus: 'a' }
    state.sel.playing = false
    loadDetail(id); loadDetail(parent)
    state.dirty.compare = true
  } else {
    toast('no parent to compare — ⇧click another card to pick one', [])
  }
}

function openEncode(id) {
  if (id == null) return
  const s = sessionOf(id)
  state.ui.sheet = { kind: 'encode', sessionId: id, fps: authoredFps(s), format: 'mp4' }
  if (s.detail == null) loadDetail(id)
  state.dirty.overlay = true
}

function runFlow(mode, confirmed) {
  const pf = state.draft.preflight
  const errors = pf.issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    toast(`✕ preflight: ${errors[0].message}`, [{ label: 'SHOW', event: { ev: 'issue-jump', field: errors[0].field, section: errors[0].section } }])
    return
  }
  const hours = pf.estimate != null ? pf.estimate.wallClockSec / 3600 : 0
  if (hours > 8 && !confirmed) {
    state.ui.confirmPending = { kind: 'longRun', payload: { mode, text: `≈${fmtDur(pf.estimate.wallClockSec)} — run anyway?` } }
    return
  }
  postRun(mode)
}

function scrubBy(delta) {
  const sid = stageSessionId()
  if (sid == null) return
  const frames = sessionFrames(sessionOf(sid))
  if (frames === 0) return
  state.sel.frameIdx = clamp((state.sel.frameIdx ?? frames) + delta, 1, frames)
  state.sel.playing = false
  anim.flinging = false
  state.dirty.stage = true; state.dirty.filmstrip = true
}

function togglePlay() {
  const sid = stageSessionId()
  if (sid == null) return
  if (sessionFrames(sessionOf(sid)) === 0) return
  state.sel.playing = !state.sel.playing
  if (state.sel.playing) {
    anim.playLastAt = state.now
    if (state.sel.frameIdx == null) state.sel.frameIdx = 1
    if (sessionOf(sid).detail == null) loadDetail(sid)   // playback needs authored fps
  }
}

function closeTopmost() {
  const u = state.ui
  if (u.confirmPending != null) { u.confirmPending = null; return }
  if (u.sheet != null) { u.sheet = null; state.dirty.overlay = true; return }
  if (u.inspectorOpen) { u.inspectorOpen = false; u.inspectorDiffAgainst = null; return }
  if (u.helpOpen) { u.helpOpen = false; return }
  if (u.engineRoomOpen) { u.engineRoomOpen = false; return }
  if (u.archiveOpen) { u.archiveOpen = false; return }
  if (state.sel.compare != null) { state.sel.compare = null; state.dirty.stage = true; return }
  if (u.logOpen) { u.logOpen = false; return }
  if (state.sel.playing) { state.sel.playing = false; return }
  if (state.sel.frameIdx != null) { state.sel.frameIdx = null; state.dirty.stage = true; state.dirty.filmstrip = true; return }
  if (state.sel.sessionId != null) { state.sel.sessionId = null; state.dirty.stage = true; state.dirty.filmstrip = true; state.dirty.library = true }
}

function insertIntoField(field, text) {
  const w = domCache.bench.widgets.get(field)
  const input = field === 'scenes' ? domCache.bench.scenes.ta : (w != null ? w.input : null)
  if (input == null) return
  const start = input.selectionStart ?? String(input.value).length
  const end = input.selectionEnd ?? start
  const cur = String(state.draft.values[field] ?? '')
  const base = document.activeElement === input ? input.value : cur
  const next = base.slice(0, start) + text + base.slice(end)
  setField(field, next)
  fx.forceValue = { field, caret: start + text.length }
  fx.focusField = field
}

function rerollSeed() {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  setField('seed', buf[0] % 0x7fffffff)
}

// ════════════════════════════════════════════════════════════════════════════
// § EVENT CAPTURE — delegation; handlers ONLY store raw input + scheduleRender
// ════════════════════════════════════════════════════════════════════════════

function registerEvents() {
  window.addEventListener('click', (e) => {
    state.events.push({ k: 'click', target: e.target, shiftKey: e.shiftKey, x: e.clientX, y: e.clientY })
    scheduleRender()
  })
  document.addEventListener('input', (e) => {
    const t = e.target
    if (!(t instanceof HTMLElement)) return
    const value = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.value
    if (t.dataset.field != null) state.events.push({ k: 'field', field: t.dataset.field, value })
    else if (t.dataset.ui != null) state.events.push({ k: 'ui', name: t.dataset.ui, value, idx: t.dataset.idx, col: t.dataset.col })
    else return
    scheduleRender()
  }, true)
  window.addEventListener('keydown', (e) => {
    const t = e.target
    const editable = t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    // preventDefault must be same-stack; everything else is interpreted in tick
    if (!editable && [' ', 'ArrowLeft', 'ArrowRight', '?'].includes(e.key)) e.preventDefault()
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) e.preventDefault()
    // key auto-repeat only means something for scrubbing; a held E must not flap the drawer
    if (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    state.events.push({ k: 'key', key: e.key, meta: e.metaKey || e.ctrlKey, shift: e.shiftKey, editable })
    scheduleRender()
  })
  document.addEventListener('focusin', (e) => {
    const t = e.target
    if (t instanceof HTMLElement && t.dataset.field != null) {
      state.events.push({ k: 'focus-field', field: t.dataset.field })
      scheduleRender()
    }
  })
  window.addEventListener('pointermove', (e) => {
    state.events.push({ k: 'move', x: e.clientX, y: e.clientY, target: e.target, time: e.timeStamp })
    scheduleRender()
  })
  window.addEventListener('pointerdown', (e) => {
    state.events.push({ k: 'down', x: e.clientX, y: e.clientY, target: e.target, time: e.timeStamp })
    scheduleRender()
  })
  window.addEventListener('pointerup', (e) => {
    state.events.push({ k: 'up', x: e.clientX, y: e.clientY, time: e.timeStamp })
    scheduleRender()
  })
  // a drag or hover must not survive losing the pointer or the window
  window.addEventListener('pointercancel', () => { state.events.push({ k: 'pointer-reset' }); scheduleRender() })
  window.addEventListener('blur', () => { state.events.push({ k: 'pointer-reset' }); scheduleRender() })
  window.addEventListener('scroll', () => { state.events.push({ k: 'scroll' }); scheduleRender() }, true)
  window.addEventListener('resize', () => { state.events.push({ k: 'resize' }); scheduleRender() })
  window.addEventListener('dragover', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-drop-field]') != null) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    if (!(e.target instanceof Element)) return
    const well = e.target.closest('[data-drop-field]')
    if (well == null) return
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file != null) { state.events.push({ k: 'drop', field: well.dataset.dropField, file }); scheduleRender() }
  })
}

// ════════════════════════════════════════════════════════════════════════════
// § SSE APPLICATION (inside tick)
// ════════════════════════════════════════════════════════════════════════════

function freshLive() {
  return {
    sessionId: null, state: 'idle', step: 0, stepsTotal: 0, scene: 0, sceneCount: 1,
    phase: 'scene', sPerStep: 0, etaSec: 0, elapsedSec: 0, nextFrameInSec: 0,
    frames: 0, seed: null, itsRing: new Float32Array(120), itsHead: 0, logRing: [], logHead: 0,
  }
}

function applySse(ev) {
  if (ev.id !== '') state.sse.lastEventId = Number(ev.id)
  const data = validateSse(ev.type, JSON.parse(ev.raw))
  const live = state.live
  switch (ev.type) {
    case 'state': {
      switch (data.state) {
        case 'launching': case 'loading_models': case 'rendering': case 'stopping': {
          if (live.sessionId !== data.sessionId) {
            state.live = freshLive()
            state.live.sessionId = data.sessionId
            if (state.sessions.byId[data.sessionId] == null) loadSessions()
          }
          state.live.state = data.state
          if (typeof data.seed === 'number') state.live.seed = data.seed
          const s = state.sessions.byId[data.sessionId]
          if (s != null) s.state = 'rendering'
          break
        }
        case 'done': case 'stopped': case 'failed': {
          if (live.sessionId === data.sessionId) state.live = freshLive()
          loadSessions()   // terminal summary (steps, frames, elapsed, sPerStepAvg) comes from the store
          break
        }
        default: throw new Error(`unhandled live state ${data.state}`)
      }
      state.dirty.status = true; state.dirty.library = true; state.dirty.stage = true
      state.dirty.deck = true; state.dirty.runBar = true
      break
    }
    case 'progress': {
      // a client that connected mid-render never saw a state event — adopt from progress
      if (live.sessionId == null) { live.sessionId = data.sessionId; state.dirty.stage = true; state.dirty.filmstrip = true }
      if (live.sessionId !== data.sessionId) break   // stale event from a previous render
      if (live.state !== 'stopping') live.state = 'rendering'   // a draining step must not undo STOP
      live.step = data.step; live.stepsTotal = data.stepsTotal
      live.scene = data.scene ?? 0; live.sceneCount = data.sceneCount ?? 1
      live.phase = data.phase ?? 'scene'
      live.sPerStep = data.sPerStep; live.etaSec = data.etaSec; live.elapsedSec = data.elapsedSec
      live.nextFrameInSec = data.nextFrameInSec ?? 0
      if (data.sPerStep > 0) {
        live.itsRing[live.itsHead % live.itsRing.length] = 1 / data.sPerStep
        live.itsHead++
      }
      anim.pulse = 1
      anim.lastProgressAt = state.now
      state.dirty.status = true; state.dirty.deck = true; state.dirty.spark = true; state.dirty.library = true
      break
    }
    case 'frame': {
      if (live.sessionId === data.sessionId) live.frames = data.savedTotal
      const s = state.sessions.byId[data.sessionId]
      if (s != null) s.frames = Math.max(s.frames, data.savedTotal)
      state.dirty.stage = true; state.dirty.filmstrip = true; state.dirty.library = true; state.dirty.pip = true
      break
    }
    case 'log': {
      live.logRing.push({ line: data.line, kind: data.kind })
      if (live.logRing.length > 500) live.logRing.shift()
      live.logHead++
      state.dirty.log = true
      break
    }
    case 'queue':
      state.queue = data.queued ?? null
      state.dirty.status = true; state.dirty.runBar = true
      break
    case 'encode': {
      state.encode = { jobId: data.jobId, sessionId: data.sessionId, framesDone: data.framesDone,
        framesTotal: data.framesTotal, state: data.state, outUrl: data.outUrl ?? null }
      if (data.state === 'done') loadSessions()   // artifact chip lands on the card
      if (data.state === 'failed') toast('✕ encode failed', [])
      state.dirty.overlay = true; state.dirty.library = true
      break
    }
    default: throw new Error(`unknown SSE event type ${ev.type}`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CLICK INTERPRETATION (inside tick)
// ════════════════════════════════════════════════════════════════════════════

function stageActionTarget() {
  const id = stageSessionId()
  if (id == null) toast('no session on stage yet', [])
  return id
}

function doAction(action, node, ev) {
  const u = state.ui
  switch (action) {
    case 'stop-live':
      if (state.live.sessionId != null) { postStop(state.live.sessionId); state.live.state = 'stopping'; state.dirty.status = true }
      break
    case 'queue-chip':
      if (state.queue != null) toast(`⧖ queued: ${state.queue.id}`, [{ label: 'CLEAR QUEUE', event: { ev: 'clear-queue' } }], 10000)
      break
    case 'open-boot': u.sheet = { kind: 'firstBoot' }; state.dirty.overlay = true; break
    case 'open-help': u.helpOpen = true; break
    case 'open-archive': u.archiveOpen = true; state.dirty.archive = true; break
    case 'open-presets': u.sheet = { kind: 'presets' }; state.dirty.overlay = true; break
    case 'open-engine': u.engineRoomOpen = true; state.dirty.engine = true; break
    case 'close-engine': u.engineRoomOpen = false; break
    case 'close-archive': u.archiveOpen = false; break
    case 'close-help': u.helpOpen = false; break
    case 'close-inspector': u.inspectorOpen = false; u.inspectorDiffAgainst = null; break
    case 'close-sheet': u.sheet = null; state.dirty.overlay = true; break
    case 'bench-collapse': u.benchCollapsed = !u.benchCollapsed; break
    case 'bench-toggle': {
      const key = node.dataset.section
      u.benchSections[key] = !u.benchSections[key]
      state.dirty.bench = true
      break
    }
    case 'stage-fork': { const id = stageActionTarget(); if (id != null) applyFork(id); break }
    case 'stage-compare': { const id = stageActionTarget(); if (id != null) startCompare(id); break }
    case 'stage-encode': { const id = stageActionTarget(); if (id != null) openEncode(id); break }
    case 'stage-finder': {
      const id = stageActionTarget()
      if (id != null) { fx.copyText = `outputs/${id}`; toast(`path copied: outputs/${id} — ⌘⇧G in Finder`, []) }
      break
    }
    case 'finder-copy': {
      const id = node.dataset.id
      fx.copyText = `outputs/${id}`
      toast(`path copied: outputs/${id} — ⌘⇧G in Finder`, [])
      break
    }
    case 'stage-inspect': {
      const id = stageActionTarget()
      if (id != null) { if (state.sel.sessionId == null && id !== state.live.sessionId) state.sel.sessionId = id; u.inspectorOpen = true }
      break
    }
    case 'pip-swap': state.sel.sessionId = null; state.sel.frameIdx = null; state.sel.playing = false; state.sel.compare = null; state.dirty.stage = true; state.dirty.filmstrip = true; break
    case 'fs-live': state.sel.frameIdx = null; state.sel.playing = false; anim.flinging = false; fx.fsFollow = true; state.dirty.stage = true; state.dirty.filmstrip = true; break
    case 'toggle-log':
      u.logOpen = !u.logOpen
      if (u.logOpen) fx.scrollLogBottom = true   // stickiness is meaningless while the drawer was 0px
      state.dirty.log = true
      break
    case 'set-field': setField(node.dataset.field, node.dataset.value); break
    case 'size-preset': {
      const px = Number(node.dataset.px)
      const w = Number(state.draft.values.width), h = Number(state.draft.values.height)
      const aspect = w > 0 && h > 0 ? h / w : 1
      setFields({ width: px, height: Math.round(px * aspect / 8) * 8 })
      break
    }
    case 'aspect-preset': {
      const rw = Number(node.dataset.w), rh = Number(node.dataset.h)
      const w = Number(state.draft.values.width)
      if (w > 0) setField('height', Math.round(w * rh / rw / 8) * 8)
      break
    }
    case 'size-match-init': setFields({ width: -1, height: -1 }); break
    case 'coherence-level': setField('direct_stabilization_weight', COHERENCE_WEIGHTS[node.dataset.level]); break
    case 'clip-preset': applyClipPreset(node.dataset.preset); break
    case 'motion-chip': setFields(JSON.parse(node.dataset.writes)); break
    case 'expr-chip': setField(node.dataset.field, node.dataset.text); fx.forceValue = { field: node.dataset.field, caret: node.dataset.text.length }; break
    case 'insert-token': insertIntoField('scenes', node.dataset.text); break
    case 'help-insert': insertIntoField(lastFocusedField, node.dataset.text); break
    case 'help-setting': u.helpOpen = false; u.engineRoomOpen = true; u.engineRoomSearch = node.dataset.field; state.dirty.engine = true; fx.focusEngineSearch = true; break
    case 'browse-open': u.sheet = { kind: 'browse', field: node.dataset.field, path: '', entries: null }; state.dirty.overlay = true; loadBrowse(''); break
    case 'browse-entry': {
      if (u.sheet == null || u.sheet.kind !== 'browse') break
      if (node.dataset.dir === '1') { u.sheet.path = node.dataset.path; u.sheet.entries = null; loadBrowse(node.dataset.path) }
      else { setField(u.sheet.field, node.dataset.path); u.sheet = null }
      state.dirty.overlay = true
      break
    }
    case 'band-add': {
      const cur = Array.isArray(state.draft.values.input_audio_filters) ? state.draft.values.input_audio_filters : []
      setField('input_audio_filters', [...cur, { variable_name: '', f_center: -1, f_width: -1, order: 5 }])
      break
    }
    case 'band-del': {
      const cur = Array.isArray(state.draft.values.input_audio_filters) ? state.draft.values.input_audio_filters : []
      const next = cur.filter((_, i) => i !== Number(node.dataset.idx))
      setField('input_audio_filters', next.length > 0 ? next : null)
      break
    }
    case 'seed-lock': state.draft.seedLocked = !state.draft.seedLocked; markEdited('seed'); break
    case 'seed-roll': rerollSeed(); break
    case 'run': runFlow('now', false); break
    case 'run-queue': runFlow('queue', false); break
    case 'run-preempt': runFlow('preempt', false); break   // STOP & RUN NOW is one act (§9)
    case 'toast-action': {
      const t = u.toast
      u.toast = null
      if (t == null) break
      const act = t.actions[Number(node.dataset.idx)]
      if (act == null) break
      doToastEvent(act.event)
      break
    }
    case 'confirm-yes': {
      const c = u.confirmPending
      u.confirmPending = null
      if (c == null) break
      switch (c.kind) {
        case 'longRun': postRun(c.payload.mode); break
        case 'delete': deleteSession(c.payload); break
        case 'preempt': postRun('preempt'); break
        default: throw new Error(`unknown confirm kind ${c.kind}`)
      }
      break
    }
    case 'confirm-no': u.confirmPending = null; break
    case 'resume': postResume(node.dataset.id); break
    case 'delete-ask': u.confirmPending = { kind: 'delete', payload: node.dataset.id }; break
    case 'fork': applyFork(node.dataset.id); break
    case 'encode-open': case 'artifact': openEncode(node.dataset.id); break
    case 'inspect': { state.sel.sessionId = node.dataset.id; loadDetail(node.dataset.id); u.inspectorOpen = true; break }
    case 'compare-with': startCompare(node.dataset.id); break
    case 'select': selectSession(node.dataset.id, ev.shiftKey); break
    case 'er-reset': {
      let n = 0
      for (const name of Object.keys(state.schema.fields)) {
        if (name === 'scenes' || ER_HIDDEN.has(name)) continue
        if (isModified(name)) { state.draft.values[name] = fieldMeta(name).default ?? null; n++ }
      }
      markEdited('reset')
      toast(`reset ${n} fields to schema defaults (scenes kept)`, [])
      break
    }
    case 'er-help': {
      const set = domCache.engineRoom.helpOpen
      if (set.has(node.dataset.field)) set.delete(node.dataset.field); else set.add(node.dataset.field)
      state.dirty.engine = true
      break
    }
    case 'er-nav': fx.scrollGroup = node.dataset.group; break
    case 'er-force': {
      const set = domCache.engineRoom.forceOpen
      if (set.has(node.dataset.group)) set.delete(node.dataset.group); else set.add(node.dataset.group)
      state.dirty.engine = true
      break
    }
    case 'arch-status': u.archiveFilter.status = node.dataset.status; state.dirty.archive = true; break
    case 'arch-video': u.archiveFilter.hasVideo = !u.archiveFilter.hasVideo; state.dirty.archive = true; break
    case 'arch-sort': u.archiveFilter.sort = u.archiveFilter.sort === 'newest' ? 'lineage' : 'newest'; state.dirty.archive = true; break
    case 'starter-load': applyStarter(Number(node.dataset.idx)); break
    case 'encode-run': {
      const sh = u.sheet
      if (sh == null || sh.kind !== 'encode') break
      const fps = sh.fps
      if (fps == null || !(fps > 0)) { toast('fps not known yet — session config still loading', []); break }
      postEncode(sh.sessionId, fps, sh.format, false)
      break
    }
    case 'encode-cancel': if (state.encode != null) cancelEncode(state.encode.jobId); break
    case 'encode-format': if (u.sheet != null && u.sheet.kind === 'encode') { u.sheet.format = node.dataset.format; state.dirty.overlay = true } break
    case 'encode-proxy': {
      const sh = u.sheet
      if (sh != null && sh.kind === 'encode' && sh.fps != null) postEncode(sh.sessionId, sh.fps, 'mp4', true)
      break
    }
    case 'preset-load': {
      const p = state.presets.find((p) => p.name === node.dataset.name)
      if (p == null) throw new Error(`preset ${node.dataset.name} not in mirror`)
      state.draft.values = { ...schemaDefaults(), ...p.values }
      markEdited('scenes')
      state.dirty.sceneMap = true
      u.sheet = null; state.dirty.overlay = true
      toast(`loaded preset ${p.name}`, [])
      break
    }
    case 'preset-delete': deletePreset(node.dataset.name); break
    case 'preset-save': {
      const input = domCache.sheet.nodes.presetName
      if (input != null && input.value.trim() !== '') { savePreset(input.value.trim()); u.sheet = null; state.dirty.overlay = true }
      break
    }
    case 'compare-lock': {
      const cmp = state.sel.compare
      if (cmp == null) break
      cmp.focus = node.dataset.side
      cmp.locked = !cmp.locked
      if (cmp.locked) cmp.stepOffset = 0
      state.dirty.compare = true
      break
    }
    case 'compare-exit': state.sel.compare = null; state.dirty.stage = true; break
    case 'cmp-diff': {
      const cmp = state.sel.compare
      if (cmp == null) break
      u.inspectorOpen = true
      u.inspectorDiffAgainst = cmp.otherId
      break
    }
    case 'inspector-fork': { const id = state.sel.sessionId ?? stageSessionId(); if (id != null) { applyFork(id); u.inspectorOpen = false } break }
    case 'issue-jump': {
      const section = node.dataset.section
      if (section && u.benchSections[section] !== undefined) u.benchSections[section] = true
      fx.scrollToField = node.dataset.field
      fx.focusField = node.dataset.field
      state.dirty.bench = true
      break
    }
    case 'clear-queue': clearQueue(); break
    case 'sheet-play':
      if (u.sheet != null && u.sheet.kind === 'encode') { u.sheet.playUrl = node.dataset.url; state.dirty.overlay = true }
      break
    case 'system-save': {
      const n = domCache.sheet.nodes
      if (n.deviceIn == null) break
      postSystem({
        device: n.deviceIn.value.trim() === '' ? null : n.deviceIn.value.trim(),
        models_parent_dir: n.modelsIn.value.trim(),
        approximate_vram_usage: n.vramIn.checked,
      })
      break
    }
    default:
      throw new Error(`unhandled action ${JSON.stringify(action)}`)
  }
}

function doToastEvent(event) {
  switch (event.ev) {
    case 'clear-queue': clearQueue(); break
    case 'run-queue': postRun('queue'); break
    case 'run-preempt': postRun('preempt'); break
    case 'issue-jump': {
      const section = event.section
      if (section && state.ui.benchSections[section] !== undefined) state.ui.benchSections[section] = true
      fx.scrollToField = event.field
      fx.focusField = event.field
      state.dirty.bench = true
      break
    }
    default: throw new Error(`unhandled toast event ${JSON.stringify(event.ev)}`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § KEYBOARD (inside tick) — single-key when no field focused; ⌘-chords always
// ════════════════════════════════════════════════════════════════════════════

function handleKey(ev) {
  const u = state.ui
  if (ev.meta && ev.key === 'Enter') { runFlow('now', false); return }
  if (ev.meta && (ev.key === 'k' || ev.key === 'K')) { u.engineRoomOpen = true; state.dirty.engine = true; fx.focusEngineSearch = true; return }
  if (ev.editable) { if (ev.key === 'Escape') fx.blur = true; return }
  switch (ev.key) {
    case 'r': case 'R': runFlow('now', false); break
    case 'f': case 'F': { const id = stageSessionId(); if (id != null) applyFork(id); break }
    case 'c': case 'C': { const id = stageSessionId(); if (id != null) startCompare(id); break }
    case 'g': case 'G': u.archiveOpen = !u.archiveOpen; state.dirty.archive = true; break
    case 'i': case 'I': {
      u.inspectorOpen = !u.inspectorOpen
      if (u.inspectorOpen) { const id = stageSessionId(); if (id != null) loadDetail(id); else u.inspectorOpen = false }
      else u.inspectorDiffAgainst = null
      break
    }
    case 'e': case 'E': u.engineRoomOpen = !u.engineRoomOpen; state.dirty.engine = true; break
    case 'l': case 'L':
      u.logOpen = !u.logOpen
      if (u.logOpen) fx.scrollLogBottom = true
      state.dirty.log = true
      break
    case '?': u.helpOpen = !u.helpOpen; break
    case ' ': togglePlay(); break
    case 'ArrowLeft': scrubBy(ev.shift ? -10 : -1); break
    case 'ArrowRight': scrubBy(ev.shift ? 10 : 1); break
    case 'Escape': closeTopmost(); break
    default: break   // unbound keys are not an error
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § TICK — drain events, mutate state (the only mutation point after boot)
// ════════════════════════════════════════════════════════════════════════════

const FS_THUMB_STEP = 58   // filmstrip thumb width + gap, px (matches CSS)

function tick(now) {
  const evs = state.events
  state.events = []
  for (const ev of evs) {
    switch (ev.k) {
      case 'sse': applySse(ev); break
      case 'sse-open': state.sse.connected = true; state.dirty.status = true; break
      case 'sse-down': state.sse.connected = false; state.dirty.status = true; break
      case 'sessions': {
        const byId = {}
        const order = []
        for (const s of ev.sessions) {
          const prev = state.sessions.byId[s.id]
          if (prev != null && prev.detail != null) s.detail = prev.detail
          byId[s.id] = s
          order.push(s.id)
        }
        state.sessions = { byId, order }
        if (state.sel.sessionId != null && byId[state.sel.sessionId] == null) {
          state.sel.sessionId = null; state.sel.frameIdx = null; state.sel.compare = null
        }
        if (state.sel.compare != null && byId[state.sel.compare.otherId] == null) state.sel.compare = null
        state.dirty.library = true; state.dirty.archive = true; state.dirty.stage = true
        state.dirty.filmstrip = true; state.dirty.runBar = true
        break
      }
      case 'detail': {
        const s = state.sessions.byId[ev.id]
        if (s != null) {
          const { config, diffableAgainst, ...summary } = ev.detail
          Object.assign(s, summary)
          s.detail = { config }
          state.dirty.stage = true; state.dirty.overlay = true; state.dirty.compare = true
        }
        if (pendingFork === ev.id) { pendingFork = null; applyFork(ev.id) }
        if (state.ui.sheet != null && state.ui.sheet.kind === 'encode' && state.ui.sheet.sessionId === ev.id && state.ui.sheet.fps == null) {
          state.ui.sheet.fps = Number(ev.detail.config.frames_per_second)
          state.dirty.overlay = true
        }
        break
      }
      case 'detail-failed':
        if (pendingFork === ev.id) pendingFork = null   // don't fork unexpectedly on a later retry
        break
      case 'system-saved':
        // the draft mirrors the persisted system fields (same values, one truth on screen)
        for (const [key, value] of Object.entries(ev.settings)) state.draft.values[key] = value
        toast('system settings saved to studio.yaml', [])
        break
      case 'preflight':
        state.draft.preflight = ev.result
        state.dirty.bench = true; state.dirty.runBar = true
        break
      case 'run-result': {
        const body = ev.body
        if (typeof body.sessionId === 'string') {
          state.draft.dirtySinceRun = false
          if (typeof body.seed === 'number') state.draft.values.seed = body.seed   // server baked it; display it
          state.sel.sessionId = null; state.sel.frameIdx = null; state.sel.compare = null
          loadSessions()
          toast(`▶ ${body.sessionId}`, [])
        } else if (typeof body.queued === 'string' || (body.queued != null && typeof body.queued.id === 'string')) {
          state.draft.dirtySinceRun = false
          loadQueue()
          toast(`⧖ queued — runs when the live render finishes`, [])
        } else {
          throw new Error(`unrecognized POST /api/sessions response ${JSON.stringify(body)}`)
        }
        state.dirty.runBar = true; state.dirty.status = true
        break
      }
      case 'run-busy':
        toast(`busy: ${ev.live} is rendering`, [
          { label: '⧖ QUEUE', event: { ev: 'run-queue' } },
          { label: '■▶ STOP & RUN NOW', event: { ev: 'run-preempt' } },
        ], 12000)
        break
      case 'queue-state': state.queue = ev.queued; state.dirty.status = true; state.dirty.runBar = true; break
      case 'presets': state.presets = ev.presets; state.dirty.overlay = true; break
      case 'upload': {
        setField(ev.field, ev.path)
        const prev = dropPreviews.get(ev.field)
        if (prev != null) prev.path = ev.path
        break
      }
      case 'browse':
        if (state.ui.sheet != null && state.ui.sheet.kind === 'browse' && state.ui.sheet.path === ev.path) {
          state.ui.sheet.entries = ev.entries
          state.dirty.overlay = true
        }
        break
      case 'encode-started':
        state.encode = { jobId: ev.jobId, sessionId: ev.sessionId, framesDone: 0, framesTotal: 0, state: 'running', outUrl: null }
        state.dirty.overlay = true
        break
      case 'deleted': {
        delete state.sessions.byId[ev.id]
        state.sessions.order = state.sessions.order.filter((id) => id !== ev.id)
        if (state.sel.sessionId === ev.id) { state.sel.sessionId = null; state.sel.frameIdx = null; state.sel.compare = null }
        if (state.sel.compare != null && state.sel.compare.otherId === ev.id) state.sel.compare = null
        toast(`deleted ${ev.id}`, [])
        state.dirty.library = true; state.dirty.archive = true; state.dirty.stage = true
        break
      }
      case 'resumed': loadSessions(); break
      case 'stage-decoded': {
        const dc = domCache.stage
        if (ev.url === dc.loadingUrl) {
          dc.front = 1 - dc.front
          dc.shownUrl = ev.url
          dc.loadingUrl = null
          state.dirty.stage = true
        }
        break
      }
      case 'stage-decode-fail': {
        const dc = domCache.stage
        if (ev.url === dc.loadingUrl) dc.loadingUrl = null
        break
      }
      case 'timer':
        switch (ev.which) {
          case 'save': saveDraft(); break
          case 'preflight': runPreflight(); break
          default: throw new Error(`unknown timer ${ev.which}`)
        }
        break
      case 'field': setField(ev.field, ev.value); break
      case 'ui': handleUiInput(ev); break
      case 'click': {
        const t = ev.target
        if (!(t instanceof Element)) break
        const actionNode = t.closest('[data-ev]')
        if (actionNode != null) { doAction(actionNode.dataset.ev, actionNode, ev); break }
        const card = t.closest('[data-card]')
        if (card != null) { selectSession(card.dataset.card, ev.shiftKey); break }
        if (t.closest('[data-scrub="fs"]') != null) {   // click a thumb → pin it (detaches from live)
          const idx = fsIdxAtX(ev.x)
          if (idx != null) { state.sel.frameIdx = idx; state.sel.playing = false; state.dirty.stage = true; state.dirty.filmstrip = true }
        }
        break
      }
      case 'key': handleKey(ev); break
      case 'focus-field': lastFocusedField = ev.field; break
      case 'pointer-reset':
        drag.kind = null
        if (hover.scrubCardId != null || hover.fsIdx != null) {
          hover.scrubCardId = null; hover.fsIdx = null
          state.dirty.library = true; state.dirty.archive = true; state.dirty.stage = true
        }
        break
      case 'move': handleMove(ev); break
      case 'down': handleDown(ev); break
      case 'up': handleUp(ev); break
      case 'scroll':
        state.dirty.library = true; state.dirty.archive = true; state.dirty.filmstrip = true
        break
      case 'resize':
        state.dirty.library = true; state.dirty.archive = true; state.dirty.filmstrip = true; state.dirty.stage = true
        break
      case 'drop': {
        const prev = dropPreviews.get(ev.field)
        if (prev != null) URL.revokeObjectURL(prev.objUrl)
        const objUrl = URL.createObjectURL(ev.file)
        dropPreviews.set(ev.field, { objUrl, path: null, durationSec: null })
        if (ev.file.type.startsWith('video/')) {
          const probe = document.createElement('video')
          probe.preload = 'metadata'
          probe.onloadedmetadata = () => emit({ k: 'probed', field: ev.field, durationSec: probe.duration })
          probe.src = objUrl
        }
        uploadFile(ev.field, ev.file)
        break
      }
      case 'probed': {
        const prev = dropPreviews.get(ev.field)
        if (prev != null && Number.isFinite(ev.durationSec)) prev.durationSec = ev.durationSec
        state.dirty.bench = true
        break
      }
      case 'error':
        console.error(ev.message)
        toast(`✕ ${ev.message}`, [], 9000)
        break
      default:
        throw new Error(`unhandled event kind ${JSON.stringify(ev.k)}`)
    }
  }

  // ── continuous logic (post-drain) ──
  if (state.ui.toast != null && state.now > state.ui.toast.expiresAt) { state.ui.toast = null; state.dirty.toast = true }

  if (state.sel.playing) {
    const sid = stageSessionId()
    const s = sid != null ? state.sessions.byId[sid] : null
    const fps = s != null ? authoredFps(s) : null
    if (s == null) { state.sel.playing = false }
    else if (fps != null && fps > 0) {
      const frames = sessionFrames(s)
      const advance = Math.floor((state.now - anim.playLastAt) / 1000 * fps)
      if (advance > 0) {
        anim.playLastAt += advance * 1000 / fps
        const next = (state.sel.frameIdx ?? 1) + advance
        if (next >= frames) {
          state.sel.frameIdx = frames
          state.sel.playing = false
          if (sid === state.live.sessionId) state.sel.frameIdx = null   // played into the live head → follow
        } else state.sel.frameIdx = next
        state.dirty.stage = true; state.dirty.filmstrip = true
      }
    }
    // fps unknown: detail fetch in flight; playback starts when it lands
  }
}

function handleUiInput(ev) {
  switch (ev.name) {
    case 'arch-search': state.ui.archiveFilter.text = String(ev.value); state.dirty.archive = true; break
    case 'er-search': state.ui.engineRoomSearch = String(ev.value); state.dirty.engine = true; break
    case 'encode-fps': {
      if (state.ui.sheet != null && state.ui.sheet.kind === 'encode') {
        const n = Number(ev.value)
        if (Number.isFinite(n) && n > 0) { state.ui.sheet.fps = n; state.dirty.overlay = true }
      }
      break
    }
    case 'preset-name': break   // read at save-click time from the input node
    case 'inspector-diffsel': state.ui.inspectorDiffAgainst = ev.value === '' ? null : String(ev.value); state.dirty.overlay = true; break
    case 'help-search': helpSearch = String(ev.value); state.dirty.overlay = true; break
    case 'band': {
      const cur = state.draft.values.input_audio_filters
      if (!Array.isArray(cur)) break
      const idx = Number(ev.idx)
      const row = cur[idx]
      if (row == null) break
      const col = ev.col
      const next = cur.slice()
      next[idx] = { ...row, [col]: col === 'variable_name' ? String(ev.value) : Number(ev.value) }
      state.draft.values.input_audio_filters = next
      markEdited('input_audio_filters')
      break
    }
    case 'compare-scrub': {
      const cmp = state.sel.compare
      if (cmp == null) break
      const [a] = compareSides()
      const step = Number(ev.value)
      const spfA = stepsPerFrame(a)
      const oldStepA = (state.sel.frameIdx ?? sessionFrames(a)) * spfA
      if (cmp.locked) {
        // aligned: one scrub moves both sides through the same step number
        state.sel.frameIdx = clamp(Math.round(step / spfA), 1, Math.max(1, sessionFrames(a)))
      } else if (cmp.focus === 'a') {
        // A scrubs alone: compensate the offset so B holds its step
        const stepB = oldStepA + cmp.stepOffset
        state.sel.frameIdx = clamp(Math.round(step / spfA), 1, Math.max(1, sessionFrames(a)))
        cmp.stepOffset = stepB - state.sel.frameIdx * spfA
      } else {
        // B scrubs alone: A holds, the offset absorbs the motion
        cmp.stepOffset = step - oldStepA
      }
      state.dirty.compare = true
      break
    }
    default: throw new Error(`unhandled ui input ${JSON.stringify(ev.name)}`)
  }
}

// ── pointer interpretation: filmstrip drag-scrub + card hover-scrub ──

function handleDown(ev) {
  if (!(ev.target instanceof Element)) return
  if (ev.target.closest('[data-scrub="fs"]') != null) {
    const sid = stageSessionId()
    if (sid == null) return
    drag.kind = 'fs'
    drag.startX = ev.x; drag.lastX = ev.x; drag.lastT = ev.time; drag.vx = 0
    drag.startIdx = state.sel.frameIdx ?? sessionFrames(sessionOf(sid))
    state.sel.playing = false
    anim.flinging = false
    hover.fsIdx = null   // dragging owns the stage frame; the peek yields
  }
}

function handleMove(ev) {
  if (drag.kind === 'fs') {
    const dt = ev.time - drag.lastT
    if (dt > 0) drag.vx = (ev.x - drag.lastX) / dt * 1000   // px/s
    drag.lastX = ev.x; drag.lastT = ev.time
    const sid = stageSessionId()
    if (sid != null) {
      const frames = sessionFrames(sessionOf(sid))
      const idx = clamp(Math.round(drag.startIdx + (ev.x - drag.startX) / FS_THUMB_STEP), 1, Math.max(1, frames))
      if (idx !== state.sel.frameIdx) { state.sel.frameIdx = idx; state.dirty.stage = true; state.dirty.filmstrip = true }
    }
    return
  }
  if (ev.target instanceof Element) {
    const card = ev.target.closest('[data-hover-scrub]')
    if (card != null) {
      const rect = card.getBoundingClientRect()
      hover.scrubCardId = card.dataset.hoverScrub
      hover.scrubFrac = clamp((ev.x - rect.left) / Math.max(1, rect.width), 0, 1)
      state.dirty.library = true; state.dirty.archive = true
    } else if (hover.scrubCardId != null) {
      hover.scrubCardId = null
      state.dirty.library = true; state.dirty.archive = true
    }
    // filmstrip hover-peek: show the hovered frame on stage without detaching
    const overStrip = ev.target.closest('[data-scrub="fs"]') != null
    const peek = overStrip ? fsIdxAtX(ev.x) : null
    if (peek !== hover.fsIdx) { hover.fsIdx = peek; state.dirty.stage = true }
  }
}

function fsIdxAtX(x) {
  const sid = stageSessionId()
  if (sid == null) return null
  const frames = sessionFrames(sessionOf(sid))
  if (frames === 0) return null
  const rect = domCache.filmstrip.track.getBoundingClientRect()
  return clamp(Math.floor((x - rect.left) / FS_THUMB_STEP) + 1, 1, frames)
}

function handleUp(ev) {
  if (drag.kind !== 'fs') { drag.kind = null; return }
  drag.kind = null
  const sid = stageSessionId()
  if (sid == null) return
  const frames = sessionFrames(sessionOf(sid))
  const cur = state.sel.frameIdx ?? frames
  const vIdx = drag.vx / FS_THUMB_STEP                       // frames/s
  if (Math.abs(vIdx) > 2) {
    const rest = clamp(Math.round(cur + vIdx * 0.15), 1, Math.max(1, frames))
    anim.springs.fling = spring(cur, rest, vIdx)
    anim.flinging = true
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § RENDER LOOP — reads → tick → animation → batched DOM writes → side effects
// ════════════════════════════════════════════════════════════════════════════

let scheduledRaf = null
function scheduleRender() {
  if (scheduledRaf != null) return
  scheduledRaf = requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) {
    scheduledRaf = null
    if (render(now)) scheduleRender()
  })
}

function animTick(now) {
  // spring destinations derive from state HERE, before stepping and before `still`
  // is decided — setting them in the DOM-write phase would leave open/close
  // animations without a scheduled next frame
  anim.springs.engine.dest = state.ui.engineRoomOpen ? 1 : 0
  anim.springs.help.dest = state.ui.helpOpen ? 1 : 0
  anim.springs.archive.dest = state.ui.archiveOpen ? 1 : 0
  anim.springs.inspector.dest = state.ui.inspectorOpen ? 1 : 0
  anim.springs.sheet.dest = state.ui.sheet != null ? 1 : 0
  anim.springs.confirm.dest = state.ui.confirmPending != null ? 1 : 0

  let until = anim.animatedUntilTime ?? now
  const steps = Math.min(300, Math.floor((now - until) / msPerAnimationStep))   // spiral-of-death cap
  until += steps * msPerAnimationStep
  const springs = Object.values(anim.springs)
  for (let i = 0; i < steps; i++) {
    for (const s of springs) if (!springDone(s)) springStep(s)
    anim.pulse = Math.max(0, anim.pulse - 0.0025 * msPerAnimationStep)
  }
  if (reducedMotion.matches) { for (const s of springs) springSnap(s); anim.pulse = 0 }
  if (anim.flinging) {
    const f = anim.springs.fling
    const sid = stageSessionId()
    if (sid == null) anim.flinging = false
    else {
      const frames = Math.max(1, sessionFrames(sessionOf(sid)))
      state.sel.frameIdx = clamp(Math.round(f.pos), 1, frames)
      state.dirty.stage = true; state.dirty.filmstrip = true
      if (springDone(f)) { springSnap(f); anim.flinging = false }
    }
  }
  let still = anim.pulse > 0 || anim.flinging || state.sel.playing   // playback needs the loop hot
  for (const s of springs) { if (springDone(s)) springSnap(s); else still = true }
  if (anim.decays.size > 0) {
    for (const [key, at] of anim.decays) {
      if (now - at > 700) anim.decays.delete(key)
      else still = true
    }
  }
  anim.animatedUntilTime = still ? until : null
  return still
}

function render(now) {
  state.now = now

  // pre-boot (or failed boot): only the toast surface is renderable
  if (!domCache.bench.built) {
    tick(now)
    renderToastConfirm()
    return false
  }

  // ── DOM reads (batched — nothing below writes until the write phase) ──
  const dcB = domCache.bench
  const reads = {
    libTop: domCache.lib.scroll.scrollTop, libH: domCache.lib.scroll.clientHeight,
    fsLeft: domCache.filmstrip.scroll.scrollLeft, fsW: domCache.filmstrip.scroll.clientWidth,
    logAtBottom: domCache.log.rows.scrollTop + domCache.log.rows.clientHeight >= domCache.log.rows.scrollHeight - 12,
    scenesTop: dcB.scenes != null ? dcB.scenes.ta.scrollTop : 0,
    scenesLeft: dcB.scenes != null ? dcB.scenes.ta.scrollLeft : 0,
    arch: domCache.archive.built
      ? { top: domCache.archive.scroll.scrollTop, h: domCache.archive.scroll.clientHeight, w: domCache.archive.scroll.clientWidth }
      : null,
    active: document.activeElement,
  }

  tick(now)
  const still = animTick(now)

  // ── DOM writes, chunk by chunk ──
  renderStatusStrip()
  renderLibrary(reads)
  renderStageHead()
  renderStage()
  renderPip()
  renderFilmstrip(reads)
  renderProgressDeck()
  renderSparklineChunk()
  renderLogChunk(reads)
  renderBenchChunk(reads)
  renderSceneMap(reads)
  renderRunBar(reads)
  renderEngineRoomChunk(reads)
  renderArchiveChunk(reads)
  renderCompareChunk(reads)
  renderInspectorChunk(reads)
  renderSheetChunk(reads)
  renderHelpChunk(reads)
  renderToastConfirm()
  document.title = state.live.sessionId != null && state.live.stepsTotal > 0
    ? `▶ ${Math.round(state.live.step / state.live.stepsTotal * 100)}% · ${fmtDur(state.live.etaSec)} — PYTTI`
    : 'PYTTI STUDIO'

  state.dirty = {}

  // ── side effects ──
  applyFx()

  // countdown / playback / toast expiry need coarse re-render while live
  const needCoarse = state.live.sessionId != null || state.sel.playing || state.ui.toast != null
  if (needCoarse && timers.coarse === 0) {
    timers.coarse = setTimeout(() => { timers.coarse = 0; scheduleRender() }, 250)
  }
  return still
}

function applyFx() {
  if (fx.forceValue != null) {
    const { field, caret } = fx.forceValue
    const w = domCache.bench.widgets.get(field)
    const input = field === 'scenes' ? domCache.bench.scenes.ta : (w != null ? w.input : null)
    if (input != null) {
      input.value = String(state.draft.values[field] ?? '')
      input.focus()
      if (input.setSelectionRange) input.setSelectionRange(caret, caret)
    }
    fx.forceValue = null
    fx.focusField = null
  }
  if (fx.focusField != null) {
    const w = domCache.bench.widgets.get(fx.focusField)
    const input = fx.focusField === 'scenes' ? domCache.bench.scenes.ta : (w != null ? w.input : null)
    if (input != null) input.focus()
    fx.focusField = null
  }
  if (fx.scrollToField != null) {
    const w = domCache.bench.widgets.get(fx.scrollToField)
    const node = fx.scrollToField === 'scenes' ? domCache.bench.scenes.ta : (w != null ? w.row : null)
    if (node != null) node.scrollIntoView({ block: 'center' })
    fx.scrollToField = null
  }
  if (fx.scrollLogBottom) { domCache.log.rows.scrollTop = domCache.log.rows.scrollHeight; fx.scrollLogBottom = false }
  if (fx.fsFollow) { domCache.filmstrip.scroll.scrollLeft = domCache.filmstrip.track.offsetWidth; fx.fsFollow = false }
  if (fx.focusEngineSearch) {
    if (domCache.engineRoom.built) {
      domCache.engineRoom.search.value = state.ui.engineRoomSearch
      domCache.engineRoom.search.focus()
    }
    fx.focusEngineSearch = false
  }
  if (fx.scrollGroup != null) {
    const g = domCache.engineRoom.groups.get(fx.scrollGroup)
    if (g != null) g.root.scrollIntoView({ block: 'start' })
    fx.scrollGroup = null
  }
  if (fx.blur) { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); fx.blur = false }
  if (fx.copyText != null) { navigator.clipboard.writeText(fx.copyText).catch(() => {}); fx.copyText = null }
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: status strip (permanent projection)
// ════════════════════════════════════════════════════════════════════════════

const STATE_GLYPHS = {
  rendering: ['●', 'var(--signal)', 'REC'], done: ['✓', 'var(--phos)', 'DONE'],
  stopped: ['■', 'var(--text)', 'STOP'], failed: ['✕', 'var(--danger)', 'FAIL'],
  queued: ['⧖', 'var(--accent)', 'QUEUED'], imported: ['▤', 'var(--text)', 'IMPORTED'],
}

// "○ READY · mps · models ok · ffmpeg ok" (§3.2) from whatever /api/health reports
function healthSummary() {
  if (state.health == null) return ''
  const parts = []
  for (const [key, v] of Object.entries(state.health)) {
    if (typeof v === 'boolean') parts.push(`${key} ${v ? 'ok' : '✕'}`)
    else if (typeof v === 'string' && v !== '') parts.push(v)
  }
  return parts.slice(0, 4).join(' · ')
}

function renderStatusStrip() {
  const dc = domCache.status
  const live = state.live
  if (live.sessionId != null) {
    dc.led.textContent = '●'
    dc.led.style.color = 'var(--signal)'
    dc.led.style.opacity = String(0.35 + 0.65 * anim.pulse)   // pulse keyed to real progress events
    let label
    switch (live.state) {
      case 'launching': label = `LAUNCHING ${live.sessionId}`; break
      case 'loading_models': label = `LOADING MODELS ${live.sessionId}`; break
      case 'stopping': label = `stopping ${live.sessionId}…`; break
      default: label = `REC ${live.sessionId} · ${live.step}/${live.stepsTotal} · ${live.sPerStep.toFixed(1)} s/step · ETA ${fmtDur(live.etaSec)}`
    }
    dc.label.textContent = label
    dc.stop.style.display = 'inline-block'
  } else {
    dc.led.textContent = '○'
    dc.led.style.color = 'var(--text)'
    dc.led.style.opacity = '1'
    dc.label.textContent = state.sse.connected
      ? `READY${healthSummary() !== '' ? ' · ' + healthSummary() : ''}`
      : 'READY · reconnecting event stream…'
    dc.stop.style.display = 'none'
  }
  if (state.queue != null) {
    dc.queueChip.style.display = 'inline-block'
    dc.queueChip.textContent = `⧖ ${state.queue.id}`
  } else {
    dc.queueChip.style.display = 'none'
    dc.queueChip.textContent = '⧖'
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: library rail — JIT + inline eviction, spacer-based occlusion
// ════════════════════════════════════════════════════════════════════════════

const LIB_CARD_H = 96

function libCardCreate(id) {
  const node = el('div', 'lib-card')
  node.dataset.card = id
  node.dataset.hoverScrub = id
  const thumb = el('img', 'card-thumb'); thumb.alt = ''; thumb.draggable = false
  const line1 = el('div', 'card-line1')
  const status = el('span', 'card-status')
  const idEl = el('span', 'card-id')
  line1.appendChild(status); line1.appendChild(idEl)
  const delta = el('div', 'card-delta')
  const meta = el('div', 'card-meta')
  node.appendChild(thumb); node.appendChild(line1); node.appendChild(delta); node.appendChild(meta)
  return { node, thumb, status, idEl, delta, meta, metaKey: '', thumbUrl: '' }
}

function hoverThumbIdx(id, frames) {
  // coarse in-place scrub over ~12 sampled thumbs
  const k = Math.floor(hover.scrubFrac * 12)
  return clamp(Math.round(1 + k * (frames - 1) / 11), 1, frames)
}

function cardStateGlyph(s) {
  if (s.id === state.live.sessionId) return STATE_GLYPHS.rendering
  const g = STATE_GLYPHS[s.state]
  if (g == null) throw new Error(`no glyph for session state ${s.state}`)
  return g
}

function projectCard(rec, s) {
  const frames = sessionFrames(s)
  const [glyph, color, word] = cardStateGlyph(s)
  rec.status.textContent = `${glyph} ${word}`
  rec.status.style.color = color
  rec.idEl.textContent = s.id
  rec.delta.textContent = s.deltaSummary ?? (s.imported ? 'imported' : '')
  const isLive = s.id === state.live.sessionId
  const selected = state.sel.sessionId === s.id || (state.sel.sessionId == null && isLive)
  const compared = state.sel.compare != null && (state.sel.compare.otherId === s.id || state.sel.sessionId === s.id)
  rec.node.className = `lib-card${selected ? ' selected' : ''}${isLive ? ' live' : ''}${compared ? ' compared' : ''}`
  rec.node.style.boxShadow = isLive ? `0 0 ${4 + 8 * anim.pulse}px rgba(255,109,0,${0.12 + 0.3 * anim.pulse})` : 'none'

  let url = ''
  if (frames > 0) {
    const idx = hover.scrubCardId === s.id ? hoverThumbIdx(s.id, frames) : frames
    url = thumbUrl(s.id, idx)
  }
  if (url !== rec.thumbUrl) { rec.thumbUrl = url; if (url !== '') rec.thumb.src = url }
  rec.thumb.style.display = url === '' ? 'none' : 'block'

  let metaKey, metaHtml
  if (isLive) {
    const pct = state.live.stepsTotal > 0 ? Math.round(state.live.step / state.live.stepsTotal * 100) : 0
    const filled = clamp(Math.round(pct / 25), 0, 4)
    metaKey = `live${pct}|${frames}`
    metaHtml = `<span class="bar">${'▰'.repeat(filled)}${'▱'.repeat(4 - filled)}</span> ${pct}% · ${frames} fr`
  } else {
    switch (s.state) {
      case 'stopped':
        metaKey = `stop${frames}`
        metaHtml = `${frames} fr <button class="btn tiny" data-ev="resume" data-id="${esc(s.id)}">▸ RESUME</button>`
        break
      case 'failed':
        metaKey = `fail${s.exitCode}`
        metaHtml = `exit ${s.exitCode ?? '?'}<div class="fail-excerpt">${(s.failExcerpt ?? []).map((l) => esc(l)).join('<br>')}</div>`
        break
      default: {
        const chips = s.artifacts.map((a) => `<button class="btn tiny artifact" data-ev="artifact" data-id="${esc(s.id)}">${esc(String(a.format ?? 'mp4').toUpperCase())}</button>`).join('')
        metaKey = `done${frames}|${s.artifacts.length}`
        metaHtml = `${frames} fr ${chips}`
      }
    }
  }
  if (metaKey !== rec.metaKey) { rec.metaKey = metaKey; rec.meta.innerHTML = metaHtml }
}

function renderLibrary(reads) {
  const dc = domCache.lib
  const order = state.sessions.order
  dc.empty.style.display = order.length === 0 ? 'block' : 'none'
  const start = clamp(Math.floor(reads.libTop / LIB_CARD_H) - 2, 0, Math.max(0, order.length))
  const end = clamp(Math.ceil((reads.libTop + reads.libH) / LIB_CARD_H) + 2, start, order.length)
  dc.padTop.style.height = `${start * LIB_CARD_H}px`
  dc.padBot.style.height = `${Math.max(0, order.length - end) * LIB_CARD_H}px`
  const visible = new Set()
  for (let i = start; i < end; i++) visible.add(order[i])
  for (const [id, rec] of dc.map) {
    if (!visible.has(id)) { rec.node.remove(); dc.map.delete(id) }   // evict on scroll-out
  }
  for (let i = start; i < end; i++) {
    const id = order[i]
    let rec = dc.map.get(id)
    if (rec == null) { rec = libCardCreate(id); dc.map.set(id, rec) }
    projectCard(rec, sessionOf(id))
    dc.cards.appendChild(rec.node)   // reorders in place; no-op when already last-appended in order
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: stage — double buffer + decode() + 180ms crossfade; placard; summary
// ════════════════════════════════════════════════════════════════════════════

function renderStageHead() {
  const dc = domCache.stageHead
  const sid = stageSessionId()
  if (sid == null) {
    dc.id.textContent = 'STARTER'
    dc.state.textContent = ''
    dc.meta.textContent = 'pick a starter — cost printed before you click'
    dc.actions.style.display = 'none'
    return
  }
  dc.actions.style.display = 'inline-flex'
  const s = sessionOf(sid)
  if (s.detail == null) loadDetail(sid)   // meta line needs the config snapshot; deduped
  const [glyph, color, word] = cardStateGlyph(s)
  dc.id.textContent = s.id
  dc.state.textContent = `${glyph} ${word}`
  dc.state.style.color = color
  let meta = `seed ${s.seed ?? '—'}`
  if (s.detail != null) {
    const c = s.detail.config
    const abbr = { 'Limited Palette': 'LP', 'Unlimited Palette': 'UP', 'VQGAN': 'VQ' }[c.image_model] ?? '?'
    const mode = c.animation_mode === 'off' ? 'STILL' : c.animation_mode === 'Video Source' ? 'VIDEO' : c.animation_mode
    const clips = CLIP_FIELDS.filter((f) => c[f] === true).length
    meta += ` · ${abbr} · ${mode} · ${c.width}×${c.height} · ${clips} CLIP`
  }
  dc.meta.textContent = meta
}

function renderStage() {
  const dc = domCache.stage
  const sid = stageSessionId()
  // switching sessions invalidates the buffer: never show the previous
  // session's frame under the new session's header
  if (dc.forSession !== sid) { dc.forSession = sid; dc.shownUrl = null }

  // starter ghost cards, built once, shown only for the empty library
  if (!dc.startersBuilt) {
    for (let i = 0; i < STARTERS.length; i++) {
      const st = STARTERS[i]
      const card = el('button', 'starter-card')
      card.dataset.ev = 'starter-load'; card.dataset.idx = String(i)
      card.appendChild(el('div', 'st-name', st.title))
      card.appendChild(el('div', 'st-sub', st.sub))
      card.appendChild(el('div', 'st-est', st.est))
      card.appendChild(el('div', 'st-load', '[ LOAD ]'))
      dc.starters.appendChild(card)
    }
    dc.startersBuilt = true
  }
  dc.starters.style.display = state.sessions.order.length === 0 ? 'flex' : 'none'

  let url = null
  let s = null
  if (sid != null) {
    s = sessionOf(sid)
    const frames = sessionFrames(s)
    if (frames > 0) {
      const idx = clamp(hover.fsIdx ?? state.sel.frameIdx ?? frames, 1, frames)
      url = frameUrl(sid, idx)
    }
  }

  if (url != null && url !== dc.shownUrl && url !== dc.loadingUrl) {
    dc.loadingUrl = url
    const back = dc.imgs[1 - dc.front]
    back.src = url
    back.decode().then(
      () => emit({ k: 'stage-decoded', url }),
      () => emit({ k: 'stage-decode-fail', url }),
    )
  }
  // never blanks mid-session: the front buffer holds the previous frame until the
  // new one has decoded. A session with no frames shows the bed, not stale art.
  const showing = url != null && dc.shownUrl != null
  dc.imgs[dc.front].style.opacity = showing ? '1' : '0'
  dc.imgs[1 - dc.front].style.opacity = '0'
  dc.imgs[dc.front].style.zIndex = '2'
  dc.imgs[1 - dc.front].style.zIndex = '1'

  // EXPOSING placard — the pre-first-frame truth, driven by state/progress events
  const live = state.live
  const placardOn = sid != null && sid === live.sessionId && live.frames === 0 && live.state !== 'idle'
  if (placardOn) {
    const spf = Number(state.draft.values.steps_per_frame) > 0 ? Number(state.draft.values.steps_per_frame) : 50
    const sps = live.sPerStep > 0 ? live.sPerStep : calibratedSPerStep()
    const eta = sps != null ? ` · ~${fmtDur(spf * sps)}` : ''
    let doing
    switch (live.state) {
      case 'launching': doing = 'launching…'; break
      case 'loading_models': doing = 'loading models…'; break
      case 'stopping': doing = 'stopping…'; break
      default: doing = `step ${live.step}`
    }
    dc.placard.style.display = 'flex'
    dc.placard.textContent = `EXPOSING — first frame at step ${spf}${eta} · ${doing}`
  } else {
    dc.placard.style.display = 'none'
    dc.placard.textContent = ''
  }

  // print-data summary card for DONE / STOPPED sessions
  if (s != null && (s.state === 'done' || s.state === 'stopped') && s.id !== live.sessionId) {
    dc.summary.style.display = 'block'
    dc.summary.textContent =
      `${s.state === 'done' ? '✓' : '■'} ${s.stepsDone} steps · ${s.frames} frames · ${fmtDur(s.elapsedSec)} · ${s.sPerStepAvg != null ? s.sPerStepAvg.toFixed(1) : '—'} s/step avg`
  } else {
    dc.summary.style.display = 'none'
    dc.summary.textContent = ''
  }
}

function renderPip() {
  const dc = domCache.pip
  const live = state.live
  const visible = live.sessionId != null && state.sel.sessionId != null && state.sel.sessionId !== live.sessionId
  dc.root.style.display = visible ? 'block' : 'none'
  let url = ''
  if (visible && live.frames > 0) url = thumbUrl(live.sessionId, live.frames)
  if (url !== dc.shownUrl) { dc.shownUrl = url; if (url !== '') dc.img.src = url }
  dc.img.style.display = url === '' ? 'none' : 'block'
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: filmstrip — JIT + occlusion; auto-follow unless scrubbed
// ════════════════════════════════════════════════════════════════════════════

function renderFilmstrip(reads) {
  const dc = domCache.filmstrip
  const sid = stageSessionId()
  if (dc.forSession !== sid) {
    dc.track.textContent = ''
    dc.map.clear()
    dc.forSession = sid
    dc.lastFrames = 0
  }
  if (sid == null) {
    dc.track.style.width = '0px'
    dc.count.textContent = ''
    dc.liveBtn.style.display = 'none'
    return
  }
  const s = sessionOf(sid)
  const frames = sessionFrames(s)
  dc.track.style.width = `${Math.max(1, frames) * FS_THUMB_STEP}px`
  dc.count.textContent = frames > 0 ? `${frames} saved` : 'no frames yet'

  const i0 = clamp(Math.floor(reads.fsLeft / FS_THUMB_STEP) - 2, 1, Math.max(1, frames))
  const i1 = clamp(Math.ceil((reads.fsLeft + reads.fsW) / FS_THUMB_STEP) + 3, 0, frames)
  for (const [idx, node] of dc.map) {
    if (idx < i0 || idx > i1) { node.remove(); dc.map.delete(idx) }
  }
  const cur = clamp(state.sel.frameIdx ?? frames, 1, Math.max(1, frames))
  for (let i = i0; i <= i1; i++) {
    let node = dc.map.get(i)
    if (node == null) {
      node = el('img', 'fs-thumb')
      node.alt = ''; node.draggable = false
      node.src = thumbUrl(sid, i)                       // static: frame thumbs are immutable
      node.style.left = `${(i - 1) * FS_THUMB_STEP}px`
      dc.map.set(i, node)
      dc.track.appendChild(node)
    }
    node.className = i === cur && frames > 0 ? 'fs-thumb cur' : 'fs-thumb'
  }

  const isLiveStrip = sid === state.live.sessionId
  dc.liveBtn.style.display = isLiveStrip ? 'inline-block' : 'none'
  const detached = state.sel.frameIdx != null
  dc.liveBtn.className = detached ? 'btn pulse-accent' : 'btn active'
  if (isLiveStrip && !detached && frames > dc.lastFrames) fx.fsFollow = true   // auto-follow the growing strip
  dc.lastFrames = frames
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: progress deck — the single telemetry surface
// ════════════════════════════════════════════════════════════════════════════

function renderProgressDeck() {
  const dc = domCache.deck
  const live = state.live
  const on = live.sessionId != null
  dc.root.style.opacity = on ? '1' : '0.35'
  if (!on) {
    dc.countdown.textContent = ''
    dc.step.textContent = 'STEP —/—'
    dc.step.style.color = 'var(--text)'
    dc.rate.textContent = ''
    dc.phase.textContent = ''
    dc.phase.style.color = 'var(--text)'
    dc.elapsed.textContent = ''
    dc.fill.style.width = '0%'
    dc.fill.style.background = 'var(--accent)'
    if (dc.segCount !== 1) { dc.segments.textContent = ''; dc.segCount = 1 }
    return
  }
  // "next frame in ~Ns" ticks client-side between coalesced progress events
  const since = (state.now - anim.lastProgressAt) / 1000
  const left = Math.max(0, Math.round(live.nextFrameInSec - since))
  dc.countdown.textContent = live.state === 'rendering' && live.nextFrameInSec > 0 ? `next frame in ~${left}s` : ''

  if (dc.segCount !== live.sceneCount) {   // wipe-recreate segments only when scene count changes
    dc.segments.textContent = ''
    for (let i = 0; i < live.sceneCount; i++) {
      const seg = el('div', 'pd-seg')
      seg.style.width = `${100 / live.sceneCount}%`
      dc.segments.appendChild(seg)
    }
    dc.segCount = live.sceneCount
  }
  const pct = live.stepsTotal > 0 ? live.step / live.stepsTotal * 100 : 0
  dc.fill.style.width = `${pct}%`   // numbers tick, gauges never bounce
  dc.fill.style.background = live.phase === 'interpolation' ? 'var(--expr)' : 'var(--accent)'

  const stepText = `STEP ${live.step}/${live.stepsTotal}`
  decayMark('pd-step', dc.step.textContent !== stepText)
  dc.step.textContent = stepText
  dc.step.style.color = decayColor('pd-step')
  dc.rate.textContent = live.sPerStep > 0 ? `${live.sPerStep.toFixed(1)} s/step` : ''
  let phase
  switch (live.phase) {
    case 'pre_animation': phase = 'PRE-ANIM'; break
    case 'interpolation': phase = 'XFADE'; break
    default: phase = `SCENE ${live.scene + 1}/${live.sceneCount}`
  }
  dc.phase.textContent = phase
  dc.phase.style.color = live.phase === 'scene' ? 'var(--text)' : 'var(--signal)'
  dc.elapsed.textContent = `elap ${fmtDur(live.elapsedSec)}`
}

function renderSparklineChunk() {
  if (!state.dirty.spark) return
  const live = state.live
  const ring = live.itsRing
  const n = Math.min(live.itsHead, ring.length)
  const samples = []
  for (let i = 0; i < n; i++) {
    samples.push(ring[(live.itsHead - n + i) % ring.length])
  }
  drawSparkline(domCache.deck.spark, samples, '#00e5ff')
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: log — append-only + trim; green is engine truth, the only green
// ════════════════════════════════════════════════════════════════════════════

function renderLogChunk(reads) {
  const dc = domCache.log
  const live = state.live
  const ring = live.logRing
  const last = ring.length > 0 ? ring[ring.length - 1] : null
  dc.text.textContent = last != null ? last.line : '—'
  dc.text.className = last != null ? `ll-${last.kind}` : 'll-info'
  let warns = 0, errs = 0
  for (const r of ring) { if (r.kind === 'warn') warns++; else if (r.kind === 'error') errs++ }
  dc.badge.textContent = errs > 0 ? `✕${errs}` : warns > 0 ? `⚠${warns}` : ''
  dc.badge.style.color = errs > 0 ? 'var(--danger)' : 'var(--signal)'

  dc.drawer.style.height = state.ui.logOpen ? '180px' : '0px'
  if (dc.lastHead == null || dc.lastHead > live.logHead) { dc.rows.textContent = ''; dc.lastHead = live.logHead - ring.length }
  const fresh = live.logHead - dc.lastHead
  if (fresh > 0) {
    const slice = ring.slice(ring.length - Math.min(fresh, ring.length))
    for (const r of slice) dc.rows.appendChild(el('div', `log-row ll-${r.kind}`, r.line))
    while (dc.rows.children.length > ring.length) dc.rows.firstChild.remove()
    dc.lastHead = live.logHead
    if (state.ui.logOpen && reads.logAtBottom) fx.scrollLogBottom = true   // auto-scroll unless the user scrolled up
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: bench — permanent; visibility/summary/badges/values projected
// ════════════════════════════════════════════════════════════════════════════

function projectWidgetValue(w, active) {
  const value = state.draft.values[w.name]
  if (w.input === active) return   // never clobber the field being typed in
  if (w.kind === 'BOOL') w.input.checked = value === true
  else if (w.kind !== 'LIST') w.input.value = value == null ? '' : String(value)
}

function calibBadge(model) {
  const v = state.draft.values
  const clips = clipEnabled().length
  const bucket = state.calibration.buckets[`${v.width}x${v.height}/${clips}/${model}`]
  return bucket != null ? `${bucket.sPerStep.toFixed(1)} s/step` : '— s/step'
}

function renderBenchChunk(reads) {
  const dc = domCache.bench
  const collapsed = state.ui.benchCollapsed
  domCache.cols.style.gridTemplateColumns = collapsed ? '248px 1fr 36px' : '248px 1fr 340px'
  // the collapsed spine keeps a working expand affordance — never a one-way trap
  dc.title.style.display = collapsed ? 'none' : 'inline'
  dc.state.style.display = collapsed ? 'none' : 'inline'
  dc.presetsBtn.style.display = collapsed ? 'none' : 'inline-block'
  dc.head.style.padding = collapsed ? '8px 2px' : '8px 12px'
  dc.collapseBtn.textContent = collapsed ? '◀' : '▐'
  dc.collapseBtn.title = collapsed ? 'expand bench' : 'collapse bench'
  dc.collapseBtn.className = collapsed ? 'btn spine' : 'btn'
  dc.lineage.textContent = state.draft.forkOf != null ? `forked from ${state.draft.forkOf} ${state.draft.seedLocked ? '🔒' : ''}` : ''
  dc.lineage.style.display = state.draft.forkOf != null && !collapsed ? 'block' : 'none'
  dc.state.textContent = state.draft.dirtySinceRun ? '● edited' : '○ fresh'
  dc.state.style.color = state.draft.dirtySinceRun ? 'var(--signal)' : 'var(--text)'
  dc.scroll.style.display = collapsed ? 'none' : 'block'
  domCache.runBar.root.style.display = collapsed ? 'none' : 'block'
  if (collapsed) return

  const v = state.draft.values
  const summaries = benchSummaries()
  const issues = issuesBySection()
  for (const [key] of BENCH_SECTIONS) {
    const sec = dc.sec[key]
    const open = state.ui.benchSections[key]
    const relevant = key === 'coherence' ? v.animation_mode !== 'off' : true
    sec.root.style.display = relevant ? 'block' : 'none'
    sec.arrow.textContent = open ? '▾' : '▸'
    sec.body.style.display = open ? 'block' : 'none'
    sec.summary.textContent = open ? '' : summaries[key]
    const n = (issues[key] ?? []).length
    sec.badge.textContent = n > 0 ? `⚠${n}` : ''
  }

  // widget values + per-field relevance + EXPR sparklines
  for (const [, w] of dc.widgets) {
    projectWidgetValue(w, reads.active)
    if (w.row.dataset.fieldRow != null) w.row.style.display = isRelevant(w.name) ? 'grid' : 'none'
    if (w.spark != null) {
      const src = String(v[w.name] ?? '')
      const key = `${src}|${plannedTMax()}`
      if (w.sparkKey !== key) {
        w.sparkKey = key
        const f = compileExpr(src)
        const tMax = plannedTMax()
        const samples = []
        for (let i = 0; i < 48; i++) samples.push(f != null ? f(i / 47 * tMax) : null)
        drawSparkline(w.spark, samples, '#a855f7')
      }
    }
  }

  // scenes editor: overlay tokenization + scroll sync (display-only coloring)
  const sc = dc.scenes
  const scenesVal = String(v.scenes ?? '')
  if (sc.ta !== reads.active) sc.ta.value = scenesVal
  const liveText = sc.ta === reads.active ? sc.ta.value : scenesVal
  const html = tokenizeScenes(liveText)
  if (html !== sc.lastHtml) { sc.lastHtml = html; sc.overlay.innerHTML = html }
  sc.overlay.scrollTop = reads.scenesTop
  sc.overlay.scrollLeft = reads.scenesLeft

  // model cards + panels
  for (const [model, card] of Object.entries(dc.modelCards)) {
    const on = v.image_model === model
    card.className = on ? 'model-card selected' : 'model-card'
    card.lastChild.textContent = calibBadge(model)
  }
  dc.vqPanel.style.display = v.image_model === 'VQGAN' ? 'block' : 'none'
  dc.lpPanel.style.display = v.image_model === 'Limited Palette' ? 'block' : 'none'
  dc.totalColors.textContent = `total colors = ${Number(v.palette_size) * Number(v.palettes)}`
  dc.matchInit.style.display = v.init_image ? 'inline-block' : 'none'

  // dropped-file previews (object URLs; typed paths get no preview — honest)
  const tpPrev = dropPreviews.get('target_palette')
  const tpOn = tpPrev != null && tpPrev.path === v.target_palette && v.target_palette !== ''
  dc.paletteSwatch.style.display = tpOn ? 'inline-block' : 'none'
  if (tpOn && !dc.paletteSwatch.src.endsWith(tpPrev.objUrl)) dc.paletteSwatch.src = tpPrev.objUrl
  const initPrev = dropPreviews.get('init_image')
  const initOn = initPrev != null && initPrev.path === v.init_image && v.init_image !== ''
  dc.initThumb.style.display = initOn ? 'block' : 'none'
  if (initOn && !dc.initThumb.src.endsWith(initPrev.objUrl)) dc.initThumb.src = initPrev.objUrl
  // breath-without-init is unrepresentable: the toggle lives in the well, disabled without an init
  dc.widgets.get('breath_mode').input.disabled = !v.init_image
  dc.widgets.get('semantic_init_weight').row.style.display = v.init_image ? 'grid' : 'none'
  dc.widgets.get('direct_init_weight').row.style.display = v.init_image ? 'grid' : 'none'

  // motion mode + panes
  const mode = v.animation_mode
  const modeMeta = state.schema.fields.animation_mode
  const parked3d = (modeMeta != null && modeMeta.parked === true) ||
    (state.schema.fields.rotate_3d != null && state.schema.fields.rotate_3d.parked === true)
  for (const btn of dc.modeSeg.children) {
    const on = btn.dataset.value === mode
    btn.className = `btn seg${on ? ' selected' : ''}${btn.dataset.value === '3D' && parked3d ? ' parked' : ''}`
  }
  dc.parkedNote.style.display = mode === '3D' && parked3d ? 'block' : 'none'
  dc.motionChips.style.display = mode === '2D' ? 'flex' : 'none'
  dc.pane2d.style.display = mode === '2D' ? 'block' : 'none'
  dc.pane3d.style.display = mode === '3D' ? 'block' : 'none'
  dc.paneVid.style.display = mode === 'Video Source' ? 'block' : 'none'
  dc.developFirst.style.display = mode !== 'off' ? 'grid' : 'none'
  dc.strideNote.textContent = `1 of every ${v.frame_stride} source frames`
  const vidPrev = dropPreviews.get('video_path')
  dc.vidProbe.textContent = vidPrev != null && vidPrev.durationSec != null && vidPrev.path === v.video_path
    ? `probed: ${vidPrev.durationSec.toFixed(1)}s source` : ''

  // coherence dial + flow visibility
  const level = coherenceLevel()
  for (const btn of dc.coherenceDial.children) {
    btn.className = btn.dataset.level === level ? 'btn chip selected' : 'btn chip'
  }
  dc.flowRow.style.display = mode === 'Video Source' || mode === '3D' ? 'grid' : 'none'

  // TIME readout — one-way derivation, the preflight estimate is the authority
  const est = state.draft.preflight.estimate
  dc.timeReadout.textContent = est != null
    ? `${est.stepsTotal} st · ${est.frames} fr = ${Number(est.videoSec).toFixed(1)}s @ ${v.frames_per_second}fps · ≈${fmtDur(est.wallClockSec)}`
    : 'estimating…'

  // CLIP preset chips
  const preset = clipPresetName()
  for (const btn of dc.clipChips.children) {
    btn.className = btn.dataset.preset === preset ? 'btn chip selected' : 'btn chip'
  }
  dc.clipDetail.textContent = `${clipEnabled().join(' + ') || 'none'}${preset === 'CUSTOM' ? ' · CUSTOM' : ''}`

  // audio band table — wipe-recreate only when row count changes (stateful inputs)
  const bandsRelevant = isRelevant('input_audio_filters')
  dc.bandTable.style.display = bandsRelevant ? 'block' : 'none'
  dc.bandAdd.style.display = bandsRelevant ? 'inline-block' : 'none'
  const bands = Array.isArray(v.input_audio_filters) ? v.input_audio_filters : []
  const bandCols = ['variable_name', 'f_center', 'f_width', 'order']
  if (dc.bandCount !== bands.length) {
    dc.bandCount = bands.length
    dc.bandTable.textContent = ''
    dc.bandInputs = []   // [rowIdx][colIdx] — owned refs, never re-queried from the DOM
    if (bands.length > 0) {
      const headRow = el('div', 'band-row band-head')
      for (const h of ['variable', 'f_center', 'f_width', 'order', '']) headRow.appendChild(el('span', 'band-cell', h))
      dc.bandTable.appendChild(headRow)
    }
    for (let i = 0; i < bands.length; i++) {
      const row = el('div', 'band-row')
      const rowInputs = []
      for (const col of bandCols) {
        const input = el('input', 'band-in')
        input.type = col === 'variable_name' ? 'text' : 'number'
        input.dataset.ui = 'band'; input.dataset.idx = String(i); input.dataset.col = col
        const cell = el('span', 'band-cell')
        cell.appendChild(input)
        row.appendChild(cell)
        rowInputs.push(input)
      }
      const del = el('button', 'btn tiny', '✕')
      del.dataset.ev = 'band-del'; del.dataset.idx = String(i)
      const cell = el('span', 'band-cell'); cell.appendChild(del)
      row.appendChild(cell)
      dc.bandTable.appendChild(row)
      dc.bandInputs.push(rowInputs)
    }
  }
  for (let i = 0; i < bands.length; i++) {
    for (let j = 0; j < bandCols.length; j++) {
      const input = dc.bandInputs[i][j]
      if (input !== reads.active) input.value = String(bands[i][bandCols[j]] ?? '')
    }
  }
}

// scene map strip — wipe-recreate on parse-result change (≤ a dozen nodes)
function renderSceneMap(reads) {
  const sc = domCache.bench.scenes
  const text = sc.ta === reads.active ? sc.ta.value : String(state.draft.values.scenes ?? '')
  const interp = state.draft.values.interpolation_steps
  const key = `${text} ${interp}`
  if (sc.lastMapKey === key) return
  if (reads.active != null && sc.mapStrip.contains(reads.active)) return   // don't wipe the interp input mid-edit
  sc.lastMapKey = key
  sc.mapStrip.textContent = ''
  const scenes = parseScenesForMap(text)
  for (let i = 0; i < scenes.length; i++) {
    if (i > 0) {
      // the ⇄ chip IS the interpolation_steps editor; exists only when || exists
      const chip = el('span', 'interp-chip')
      chip.appendChild(el('span', 't-pipe', '⇄'))
      if (i === 1) {
        const input = el('input', 'interp-in')
        input.type = 'number'; input.dataset.field = 'interpolation_steps'
        input.value = String(interp ?? 0)
        chip.appendChild(input)
        chip.appendChild(el('span', 'dim', 'st'))
      }
      sc.mapStrip.appendChild(chip)
    }
    const block = el('span', 'scene-block', ` ${scenes[i].label} `)
    block.title = `${scenes[i].prompts} prompt(s), ${scenes[i].neg} negative`
    sc.mapStrip.appendChild(block)
  }
  if (scenes.length > 1) sc.mapStrip.appendChild(el('span', 'dim', ` ${scenes.length} scenes`))
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: run bar — seed strip + cost meter + RUN morph (class+text projection)
// ════════════════════════════════════════════════════════════════════════════

function renderRunBar(reads) {
  const dc = domCache.runBar
  const d = state.draft
  dc.seedVal.textContent = d.values.seed != null ? String(d.values.seed) : '——'
  dc.seedLock.textContent = d.seedLocked ? '🔒' : '🔓'
  dc.seedLock.className = d.seedLocked ? 'btn locked' : 'btn'

  const est = estimateLine()
  dc.cost.textContent = est.text
  dc.cost.style.color = est.warn ? 'var(--signal)' : 'var(--text)'

  const errors = d.preflight.issues.filter((i) => i.severity === 'error')
  const issueKey = JSON.stringify(d.preflight.issues)
  if (dc.issueKey !== issueKey) {
    dc.issueKey = issueKey
    dc.issues.textContent = ''
    for (const issue of d.preflight.issues) {
      const row = el('button', `issue-row ${issue.severity}`, `${issue.severity === 'error' ? '✕' : '⚠'} ${issue.message}`)
      row.dataset.ev = 'issue-jump'; row.dataset.field = issue.field; row.dataset.section = issue.section
      dc.issues.appendChild(row)
    }
  }

  const busy = state.live.sessionId != null
  const morph = busy && d.dirtySinceRun
  const nextId = nextSessionId()
  const btnKey = `${morph}|${busy}|${nextId}|${errors.length > 0}`
  if (dc.btnKey !== btnKey) {
    dc.btnKey = btnKey
    dc.buttons.textContent = ''
    if (morph) {
      const q = el('button', 'btn run-btn queue-btn', `⧖ QUEUE ${nextId}`)
      q.dataset.ev = 'run-queue'
      const p = el('button', 'btn run-btn preempt-btn', '■▶ STOP & RUN NOW')
      p.dataset.ev = 'run-preempt'
      dc.buttons.appendChild(q); dc.buttons.appendChild(p)
    } else {
      const r = el('button', 'btn run-btn', `▶ RUN ${nextId}`)
      r.dataset.ev = 'run'
      r.disabled = errors.length > 0
      dc.buttons.appendChild(r)
    }
  }
  void reads
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: engine room — drawer over the bench column; the stage stays visible
// ════════════════════════════════════════════════════════════════════════════

function renderEngineRoomChunk(reads) {
  const dc = domCache.engineRoom
  const s = anim.springs.engine
  if (state.ui.engineRoomOpen && !dc.built) buildEngineRoom()
  if (!dc.built) { dc.root.style.display = 'none'; return }
  const hidden = !state.ui.engineRoomOpen && springDone(s) && s.dest === 0
  dc.root.style.display = hidden ? 'none' : 'flex'
  dc.root.style.transform = `translateY(${(1 - clamp(s.pos, 0, 1.05)) * 100}%)`
  if (hidden) return

  let modified = 0
  for (const name of dc.rows.keys()) if (isModified(name)) modified++
  dc.count.textContent = `preset: ${clipPresetName()} · ${modified} modified`
  if (dc.search !== reads.active) dc.search.value = state.ui.engineRoomSearch

  const q = state.ui.engineRoomSearch.trim().toLowerCase()
  const mode = String(state.draft.values.animation_mode)
  const groupHasMatch = new Map()
  for (const [name, row] of dc.rows) {
    const matches = q === '' || row.searchText.includes(q)
    row.row.style.display = matches ? 'grid' : 'none'
    if (matches) groupHasMatch.set(row.group, true)
    row.row.style.opacity = isRelevant(name) ? '1' : '0.45'
    row.modTick.style.visibility = isModified(name) ? 'visible' : 'hidden'
    if (row.prose != null) row.prose.style.display = dc.helpOpen.has(name) ? 'block' : 'none'
    projectWidgetValue(row, reads.active)
    if (row.note != null) {
      if (name === 'gradient_accumulation_steps') {
        const gas = Number(state.draft.values.gradient_accumulation_steps), cuts = Number(state.draft.values.cutouts)
        const ok = gas > 0 && cuts % gas === 0
        row.note.textContent = ok ? '✓ divides cutouts' : '✕ must divide cutouts'
        row.note.style.color = ok ? 'var(--accent)' : 'var(--signal)'   // client verdict, not engine truth — never green
      } else {
        row.note.textContent = '0 = auto-match steps_per_frame'
        row.note.style.color = 'var(--text)'
      }
    }
  }
  for (const [groupName, g] of dc.groups) {
    let anyRelevant = false
    for (const [name, row] of dc.rows) {
      if (row.group === groupName && isRelevant(name)) { anyRelevant = true; break }
    }
    const collapsed = !anyRelevant && !dc.forceOpen.has(groupName)
    g.root.style.display = q === '' || groupHasMatch.get(groupName) === true ? 'block' : 'none'
    g.body.style.display = collapsed ? 'none' : 'block'
    g.inactive.style.display = anyRelevant ? 'none' : 'block'
    g.inactive.textContent = `${groupName} — inactive in ${mode === 'off' ? 'OFF' : mode} (${collapsed ? 'expand anyway ▸' : 'collapse ▾'})`
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: archive — overlay grid, JIT + occlusion, hover-scrub, lineage rows
// ════════════════════════════════════════════════════════════════════════════

const ARCH_COL_W = 216
const ARCH_ROW_H = 252

function archCardCreate(id) {
  const node = el('div', 'arch-card')
  node.dataset.card = id
  node.dataset.hoverScrub = id
  const poster = el('img', 'arch-poster'); poster.alt = ''; poster.draggable = false
  const idEl = el('div', 'card-id')
  const line = el('div', 'arch-line')
  const delta = el('div', 'card-delta')
  const seed = el('div', 'arch-seed')
  const btns = el('div', 'arch-btns')
  node.appendChild(poster); node.appendChild(idEl); node.appendChild(line)
  node.appendChild(delta); node.appendChild(seed); node.appendChild(btns)
  return { node, poster, idEl, line, delta, seed, btns, btnKey: '', posterUrl: '' }
}

function renderArchiveChunk(reads) {
  const dc = domCache.archive
  const s = anim.springs.archive
  if (state.ui.archiveOpen && !dc.built) buildArchive()
  if (!dc.built) { dc.root.style.display = 'none'; return }
  const hidden = !state.ui.archiveOpen && springDone(s) && s.dest === 0
  dc.root.style.display = hidden ? 'none' : 'flex'
  dc.root.style.opacity = String(clamp(s.pos, 0, 1))
  if (hidden) return

  const f = state.ui.archiveFilter
  if (dc.search !== reads.active) dc.search.value = f.text
  for (const btn of dc.statusBtns.children) {
    btn.className = btn.dataset.status === f.status ? 'btn chip selected' : 'btn chip'
  }
  dc.videoBtn.className = f.hasVideo ? 'btn chip selected' : 'btn chip'
  dc.sortBtn.textContent = `${f.sort}▾`

  // lineage rows (lineage sort only)
  const list = archiveFiltered()
  const linKey = `${f.sort}|${state.sessions.order.join(',')}`
  if (dc.lastKey !== linKey) {
    dc.lastKey = linKey
    dc.lineage.textContent = ''
    if (f.sort === 'lineage') {
      for (const family of lineageFamilies()) {
        const row = el('div', 'lin-row')
        for (let i = 0; i < family.length; i++) {
          if (i > 0) row.appendChild(el('span', 'dim', family[i].depth > family[i - 1].depth ? ' ─▶ ' : ' └▶ '))
          const sess = sessionOf(family[i].id)
          const [glyph, color] = cardStateGlyph(sess)
          const b = el('button', 'lin-id', `${family[i].id} ${glyph}`)
          b.dataset.ev = 'select'; b.dataset.id = family[i].id
          b.style.color = color
          row.appendChild(b)
        }
        dc.lineage.appendChild(row)
      }
    }
  }
  dc.lineage.style.display = f.sort === 'lineage' ? 'block' : 'none'

  // occlusion-culled grid (thumbs only, fixed row height = safe lower bound)
  const arch = reads.arch ?? { top: 0, h: 600, w: 900 }
  const cols = Math.max(1, Math.floor(arch.w / ARCH_COL_W))
  const rows = Math.ceil(list.length / cols)
  dc.plane.style.height = `${Math.max(1, rows) * ARCH_ROW_H}px`
  const r0 = Math.max(0, Math.floor(arch.top / ARCH_ROW_H) - 1)
  const r1 = Math.min(rows, Math.ceil((arch.top + arch.h) / ARCH_ROW_H) + 1)
  const visible = new Set()
  for (let r = r0; r < r1; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (i >= list.length) break
      visible.add(list[i].id)
    }
  }
  for (const [id, rec] of dc.map) {
    if (!visible.has(id)) { rec.node.remove(); dc.map.delete(id) }
  }
  for (let r = r0; r < r1; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (i >= list.length) break
      const sess = list[i]
      let rec = dc.map.get(sess.id)
      if (rec == null) { rec = archCardCreate(sess.id); dc.map.set(sess.id, rec); dc.plane.appendChild(rec.node) }
      rec.node.style.left = `${c * ARCH_COL_W}px`
      rec.node.style.top = `${r * ARCH_ROW_H}px`
      projectArchCard(rec, sess)
    }
  }
}

function projectArchCard(rec, s) {
  const frames = sessionFrames(s)
  const [glyph, color, word] = cardStateGlyph(s)
  let url = ''
  if (frames > 0) {
    const idx = hover.scrubCardId === s.id ? hoverThumbIdx(s.id, frames) : frames
    url = thumbUrl(s.id, idx)
  }
  if (url !== rec.posterUrl) { rec.posterUrl = url; if (url !== '') rec.poster.src = url }
  rec.poster.style.display = url === '' ? 'none' : 'block'
  rec.idEl.textContent = s.id
  rec.line.textContent = `${glyph} ${word} · ${frames}f${s.sPerStepAvg != null ? ` · ${s.sPerStepAvg.toFixed(1)}s/st` : ''}`
  rec.line.style.color = color
  rec.delta.textContent = s.deltaSummary ?? (s.imported ? 'imported — adopted read-only' : '')
  rec.seed.textContent = s.seed != null ? `seed ${s.seed}` : ''
  const inCompare = state.sel.compare != null && (state.sel.compare.otherId === s.id || state.sel.sessionId === s.id)
  rec.node.className = `arch-card${inCompare ? ' compared' : ''}`
  const btnKey = `${s.state}|${frames}|${s.artifacts.length}`
  if (rec.btnKey !== btnKey) {
    rec.btnKey = btnKey
    const b = []
    b.push(`<button class="btn tiny fork" data-ev="fork" data-id="${esc(s.id)}">FORK</button>`)
    if (frames > 0) b.push(`<button class="btn tiny" data-ev="encode-open" data-id="${esc(s.id)}">🎞</button>`)
    b.push(`<button class="btn tiny" data-ev="compare-with" data-id="${esc(s.id)}">⇆</button>`)
    b.push(`<button class="btn tiny" data-ev="inspect" data-id="${esc(s.id)}">ⓘ</button>`)
    if (s.state === 'stopped') b.push(`<button class="btn tiny" data-ev="resume" data-id="${esc(s.id)}">▶ RESUME</button>`)
    b.push(`<button class="btn tiny danger" data-ev="delete-ask" data-id="${esc(s.id)}">✕</button>`)
    rec.btns.innerHTML = b.join('')
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: compare — 2-up, aligned by STEP NUMBER, per-side unlock
// ════════════════════════════════════════════════════════════════════════════

function renderCompareChunk(reads) {
  const dc = domCache.compare
  const cmp = state.sel.compare
  if (cmp != null && !dc.built) buildCompare()
  if (!dc.built) { dc.root.style.display = 'none'; return }
  dc.root.style.display = cmp == null ? 'none' : 'flex'
  if (cmp == null) return

  const [a, b] = compareSides()
  const framesA = Math.max(1, sessionFrames(a))
  const framesB = Math.max(1, sessionFrames(b))
  const spfA = stepsPerFrame(a), spfB = stepsPerFrame(b)
  const frameA = clamp(state.sel.frameIdx ?? framesA, 1, framesA)
  const stepShared = frameA * spfA
  const frameB = clamp(Math.round((stepShared + cmp.stepOffset) / spfB), 1, framesB)

  const tag = (x) => x.id === state.live.sessionId ? '● live' : x.state
  dc.head.textContent = `COMPARE ${a.id} (${tag(a)}) ⇆ ${b.id} (${tag(b)}) · seeds ${a.seed ?? '?'} / ${b.seed ?? '?'}`
  const bothConfigs = a.detail != null && b.detail != null
  dc.delta.textContent = bothConfigs ? `Δ ${configDiff(a.detail.config, b.detail.config).length} fields [view diff]` : 'Δ …'

  const urls = [sessionFrames(a) > 0 ? frameUrl(a.id, frameA) : '', sessionFrames(b) > 0 ? frameUrl(b.id, frameB) : '']
  for (let i = 0; i < 2; i++) {
    if (urls[i] !== dc.shown[i]) { dc.shown[i] = urls[i]; if (urls[i] !== '') dc.imgs[i].src = urls[i] }
    dc.imgs[i].style.display = urls[i] === '' ? 'none' : 'block'
  }
  dc.labels[0].textContent = `A: fr ${frameA} @ step ${Math.round(stepShared)}`
  dc.labels[1].textContent = `B: fr ${frameB} @ step ${Math.round(stepShared + cmp.stepOffset)}${cmp.stepOffset !== 0 ? ` (offset ${cmp.stepOffset > 0 ? '+' : ''}${Math.round(cmp.stepOffset)})` : ''}`
  dc.locks[0].textContent = cmp.locked ? '🔒' : (cmp.focus === 'a' ? '🔓A' : '🔒')
  dc.locks[1].textContent = cmp.locked ? '🔒' : (cmp.focus === 'b' ? '🔓B' : '🔒')

  const stepsA = a.id === state.live.sessionId ? state.live.step : a.stepsDone
  const stepsB = b.id === state.live.sessionId ? state.live.step : b.stepsDone
  dc.scrub.max = String(Math.max(stepsA, stepsB, 1))
  if (dc.scrub !== reads.active) {
    dc.scrub.value = String(Math.round(cmp.locked || cmp.focus === 'a' ? stepShared : stepShared + cmp.stepOffset))
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: inspector + diff — wipe-recreate per open (keyed)
// ════════════════════════════════════════════════════════════════════════════

function renderInspectorChunk(reads) {
  const dc = domCache.inspector
  const open = state.ui.inspectorOpen
  const s = anim.springs.inspector
  const hidden = !open && springDone(s) && s.dest === 0
  dc.root.style.display = hidden ? 'none' : 'block'
  dc.root.style.opacity = String(clamp(s.pos, 0, 1))
  if (hidden) { dc.key = ''; dc.root.textContent = ''; return }
  const sid = state.sel.sessionId ?? stageSessionId()
  if (sid == null) return
  const sess = sessionOf(sid)
  const other = state.ui.inspectorDiffAgainst != null ? state.sessions.byId[state.ui.inspectorDiffAgainst] : null
  const key = `${sid}|${state.ui.inspectorDiffAgainst}|${sess.detail != null}|${other != null && other.detail != null}`
  if (dc.key === key) return
  if (other != null && other.detail == null) loadDetail(other.id)
  dc.key = key
  dc.root.textContent = ''

  const panel = el('div', 'panel')
  const head = el('div', 'panel-head scanlines')
  head.appendChild(el('span', 'panel-title', `INSPECT · ${sid}`))
  const diffSel = el('select', 'in-choice')
  diffSel.dataset.ui = 'inspector-diffsel'
  const none = el('option', '', 'DIFF vs —'); none.value = ''
  diffSel.appendChild(none)
  for (const id of state.sessions.order) {
    if (id === sid) continue
    const o = el('option', '', id); o.value = id
    if (id === state.ui.inspectorDiffAgainst) o.selected = true
    diffSel.appendChild(o)
  }
  head.appendChild(diffSel)
  const close = el('button', 'btn', 'esc'); close.dataset.ev = 'close-inspector'
  head.appendChild(close)
  panel.appendChild(head)

  panel.appendChild(el('div', 'insp-telemetry',
    `TELEMETRY  ${sess.stepsDone} steps · ${sess.frames} frames · ${fmtDur(sess.elapsedSec)} · ${sess.sPerStepAvg != null ? sess.sPerStepAvg.toFixed(1) : '—'} s/step avg`))

  const cfgBox = el('div', 'insp-config')
  if (sess.detail == null) {
    cfgBox.appendChild(el('div', 'dim', 'loading config…'))
    loadDetail(sid)
  } else {
    const cfg = sess.detail.config
    const otherCfg = other != null && other.detail != null ? other.detail.config : null
    const diffKeys = otherCfg != null ? new Set(configDiff(cfg, otherCfg).map((d) => d.key)) : null
    for (const [name, meta] of Object.entries(state.schema.fields)) {
      if (cfg[name] === undefined) continue
      if (diffKeys != null && !diffKeys.has(name)) continue   // only changed fields when diffing
      const row = el('div', 'insp-row')
      row.appendChild(el('span', 'insp-key', meta.label ?? name))
      const val = el('span', 'insp-val', JSON.stringify(cfg[name] ?? null))
      if (diffKeys != null) val.style.color = 'var(--signal)'   // orange highlight on differing values
      row.appendChild(val)
      if (otherCfg != null) row.appendChild(el('span', 'insp-other', `◂ ${other.id}: ${JSON.stringify(otherCfg[name] ?? null)}`))
      cfgBox.appendChild(row)
    }
    if (diffKeys != null && diffKeys.size === 0) cfgBox.appendChild(el('div', 'dim', 'configs identical'))
  }
  panel.appendChild(cfgBox)

  if (sess.artifacts.length > 0) {
    const arts = el('div', 'insp-artifacts')
    arts.appendChild(el('span', 'lbl', 'ARTIFACTS '))
    for (const a of sess.artifacts) {
      const chip = el('button', 'btn tiny artifact', `${a.name} [▶]`)
      chip.dataset.ev = 'artifact'; chip.dataset.id = sid
      arts.appendChild(chip)
    }
    panel.appendChild(arts)
  }

  const chain = [sid]
  let cursor = sess
  while (cursor.forkedFrom != null && state.sessions.byId[cursor.forkedFrom] != null && chain.length < 12) {
    chain.unshift(cursor.forkedFrom)
    cursor = state.sessions.byId[cursor.forkedFrom]
  }
  panel.appendChild(el('div', 'insp-lineage', `LINEAGE  ${chain.join(' → ')}`))

  const forkBtn = el('button', 'btn fork run-btn', '⑂ FORK THIS CONFIG')
  forkBtn.dataset.ev = 'inspector-fork'
  panel.appendChild(forkBtn)
  dc.root.appendChild(panel)
  void reads
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: sheets — encode / firstBoot / presets / browse; wipe-recreate keyed
// (the encode <video> is the only stateful node; it lives only while open)
// ════════════════════════════════════════════════════════════════════════════

const ENCODE_FORMATS = [
  ['mp4', 'MP4 H.264 CRF17 slow', 0.21],
  ['prores4444', 'ProRes 4444', 2.2],
  ['proreshq', 'ProRes HQ', 1.4],
]

function sheetKeyOf(sheet) {
  if (sheet == null) return ''
  switch (sheet.kind) {
    case 'encode': return `encode|${sheet.sessionId}|${sheet.fps != null}|${sheet.playUrl ?? ''}`
    case 'firstBoot': return 'firstBoot'
    case 'presets': return `presets|${state.presets.map((p) => p.name).join(',')}`
    case 'browse': return `browse|${sheet.field}|${sheet.path}|${sheet.entries != null}`
    default: throw new Error(`unknown sheet kind ${sheet.kind}`)
  }
}

function renderSheetChunk(reads) {
  const dc = domCache.sheet
  const sheet = state.ui.sheet
  const s = anim.springs.sheet
  const hidden = sheet == null && springDone(s) && s.dest === 0
  dc.root.style.display = hidden ? 'none' : 'block'
  dc.root.style.opacity = String(clamp(s.pos, 0, 1))
  if (hidden) { dc.key = ''; dc.root.textContent = ''; dc.nodes = {}; return }
  if (sheet == null) return

  const key = sheetKeyOf(sheet)
  if (dc.key !== key) {
    dc.key = key
    dc.root.textContent = ''
    dc.nodes = {}
    switch (sheet.kind) {
      case 'encode': buildEncodeSheet(sheet); break
      case 'firstBoot': buildFirstBootSheet(); break
      case 'presets': buildPresetsSheet(); break
      case 'browse': buildBrowseSheet(sheet); break
      default: throw new Error(`unknown sheet kind ${sheet.kind}`)
    }
  }

  // live projection of encode progress onto the open sheet
  if (sheet.kind === 'encode' && dc.nodes.progress != null) {
    const job = state.encode
    const mine = job != null && job.sessionId === sheet.sessionId
    dc.nodes.runBtn.style.display = mine && job.state === 'running' ? 'none' : 'inline-block'
    dc.nodes.progress.style.display = mine ? 'block' : 'none'
    if (mine) {
      const bars = job.framesTotal > 0 ? Math.round(job.framesDone / job.framesTotal * 6) : 0
      switch (job.state) {
        case 'running':
          dc.nodes.progress.textContent = `running: ${'▰'.repeat(bars)}${'▱'.repeat(6 - bars)} frame ${job.framesDone}/${job.framesTotal}`
          dc.nodes.cancel.style.display = 'inline-block'
          dc.nodes.doneRow.style.display = 'none'
          break
        case 'done':
          dc.nodes.progress.textContent = 'done'
          dc.nodes.cancel.style.display = 'none'
          dc.nodes.doneRow.style.display = 'block'
          if (job.outUrl != null && dc.nodes.video.dataset.url !== job.outUrl && sheet.format === 'mp4') {
            dc.nodes.video.dataset.url = job.outUrl
            dc.nodes.video.src = job.outUrl        // Range-served by the backend
            dc.nodes.video.style.display = 'block'
          }
          break
        case 'cancelled': case 'failed':
          dc.nodes.progress.textContent = job.state
          dc.nodes.cancel.style.display = 'none'
          dc.nodes.doneRow.style.display = 'none'
          break
        default: throw new Error(`unknown encode state ${job.state}`)
      }
    }
    if (dc.nodes.fps !== reads.active && sheet.fps != null) dc.nodes.fps.value = String(sheet.fps)
    // fps override wears a motion-speed warning (the 12-vs-30 silent trap dies here)
    const sess = sessionOf(sheet.sessionId)
    const authored = authoredFps(sess)
    if (authored != null && sheet.fps != null && sheet.fps !== authored) {
      dc.nodes.fpsWarn.textContent = `⚠ authored at ${authored}fps — ${sheet.fps}fps plays motion at ${(sheet.fps / authored).toFixed(1)}×`
    } else {
      dc.nodes.fpsWarn.textContent = ''
    }
    const frames = sessionFrames(sess)
    const fps = sheet.fps ?? authored
    dc.nodes.duration.textContent = fps != null ? `${frames} frames @ ${fps}fps = ${(frames / fps).toFixed(1)}s` : `${frames} frames`
    for (const fmtBtn of dc.nodes.formats.children) {
      const [fk, , mbPerFrame] = ENCODE_FORMATS.find((f) => f[0] === fmtBtn.dataset.format)
      fmtBtn.className = fk === sheet.format ? 'btn fmt-card selected' : 'btn fmt-card'
      fmtBtn.lastChild.textContent = `≈${fmtBytes(frames * mbPerFrame * 1e6)}`
    }
    if (sheet.playUrl != null && dc.nodes.video.dataset.url !== sheet.playUrl) {
      dc.nodes.video.dataset.url = sheet.playUrl
      dc.nodes.video.src = sheet.playUrl
      dc.nodes.video.style.display = 'block'
    }
  }
}

function sheetShell(title) {
  const dc = domCache.sheet
  const panel = el('div', 'panel')
  const head = el('div', 'panel-head scanlines')
  head.appendChild(el('span', 'panel-title', title))
  const close = el('button', 'btn', 'esc'); close.dataset.ev = 'close-sheet'
  head.appendChild(close)
  panel.appendChild(head)
  dc.root.appendChild(panel)
  return panel
}

function buildEncodeSheet(sheet) {
  const dc = domCache.sheet
  const sess = sessionOf(sheet.sessionId)
  const panel = sheetShell(`ENCODE · ${sheet.sessionId}`)
  const frames = sessionFrames(sess)

  const top = el('div', 'enc-top')
  if (frames > 0) {
    const poster = el('img', 'enc-poster'); poster.alt = ''
    poster.src = thumbUrl(sheet.sessionId, frames)
    top.appendChild(poster)
  }
  top.appendChild(el('div', 'enc-pattern', `${frames} frames · pattern ${sheet.sessionId}_%04d.png (autodetected, start 1)`))
  panel.appendChild(top)

  const fpsRow = el('div', 'field-row')
  fpsRow.appendChild(el('label', 'field-label', 'FPS'))
  const fps = el('input', 'in-num'); fps.type = 'number'; fps.dataset.ui = 'encode-fps'
  fps.value = sheet.fps != null ? String(sheet.fps) : ''
  fps.placeholder = sheet.fps == null ? 'loading…' : ''
  const wrap = el('span', 'field-wrap'); wrap.appendChild(fps)
  fpsRow.appendChild(el('span', 'type-badge', 'NUM')); fpsRow.appendChild(wrap)
  fpsRow.appendChild(el('div', 'field-hint', 'prefilled from the session frames_per_second'))
  panel.appendChild(fpsRow)
  const fpsWarn = el('div', 'warn-hint')
  panel.appendChild(fpsWarn)

  const formats = el('div', 'fmt-cards')
  for (const [fk, label] of ENCODE_FORMATS) {
    const b = el('button', 'btn fmt-card')
    b.dataset.ev = 'encode-format'; b.dataset.format = fk
    b.appendChild(el('div', 'fmt-name', label))
    b.appendChild(el('div', 'fmt-size', ''))
    formats.appendChild(b)
  }
  panel.appendChild(formats)
  const duration = el('div', 'derived-row', '')
  panel.appendChild(duration)

  const runBtn = el('button', 'btn run-btn', '▶ ENCODE')
  runBtn.dataset.ev = 'encode-run'
  panel.appendChild(runBtn)
  const progress = el('div', 'enc-progress', '')
  panel.appendChild(progress)
  const cancel = el('button', 'btn tiny danger', 'cancel')
  cancel.dataset.ev = 'encode-cancel'; cancel.style.display = 'none'
  panel.appendChild(cancel)

  const doneRow = el('div', 'enc-done')
  doneRow.style.display = 'none'
  const reveal = el('button', 'btn', 'COPY PATH (Finder ⌘⇧G)')
  reveal.dataset.ev = 'finder-copy'; reveal.dataset.id = sheet.sessionId
  doneRow.appendChild(reveal)
  const proxy = el('button', 'btn', 'make MP4 proxy')
  proxy.dataset.ev = 'encode-proxy'
  doneRow.appendChild(proxy)
  panel.appendChild(doneRow)

  if (sess.artifacts.length > 0) {
    const arts = el('div', 'enc-artifacts')
    arts.appendChild(el('span', 'lbl', 'existing: '))
    for (const a of sess.artifacts) {
      const chip = el('button', 'btn tiny artifact', `▶ ${a.name} (${a.fps}fps, ${fmtBytes(a.bytes)})`)
      chip.dataset.ev = 'sheet-play'
      chip.dataset.url = `/api/sessions/${sheet.sessionId}/artifacts/${encodeURIComponent(a.name)}`
      arts.appendChild(chip)
    }
    panel.appendChild(arts)
  }

  const video = el('video', 'enc-video')
  video.controls = true
  video.style.display = 'none'
  panel.appendChild(video)

  dc.nodes = { fps, fpsWarn, formats, duration, runBtn, progress, cancel, doneRow, video }
}

function buildFirstBootSheet() {
  const dc = domCache.sheet
  const panel = sheetShell('FIRST BOOT — studio check')

  panel.appendChild(el('div', 'lbl', 'HEALTH'))
  for (const [key, v] of Object.entries(state.health ?? {})) {
    const row = el('div', 'insp-row')
    row.appendChild(el('span', 'insp-key', key))
    const val = el('span', 'insp-val', typeof v === 'boolean' ? (v ? 'ok' : '✕ missing') : String(v))
    if (v === false) val.style.color = 'var(--signal)'
    row.appendChild(val)
    panel.appendChild(row)
  }

  // device / models_parent_dir / approximate_vram_usage persist via POST /api/system (studio.yaml)
  panel.appendChild(el('div', 'lbl', 'SYSTEM'))
  const v = state.draft.values
  const deviceIn = el('input', 'in-str')
  deviceIn.type = 'text'; deviceIn.placeholder = 'auto (cuda > mps > cpu)'
  deviceIn.value = v.device != null ? String(v.device) : ''
  const modelsIn = el('input', 'in-path')
  modelsIn.type = 'text'
  modelsIn.value = String(v.models_parent_dir ?? '')
  const vramIn = el('input')
  vramIn.type = 'checkbox'
  vramIn.checked = v.approximate_vram_usage === true
  for (const [label, input] of [['device', deviceIn], ['models_parent_dir', modelsIn], ['approximate_vram_usage', vramIn]]) {
    const row = el('div', 'field-row')
    row.appendChild(el('label', 'field-label', label))
    row.appendChild(el('span', 'type-badge', input.type === 'checkbox' ? 'BOOL' : 'STR'))
    const wrap = el('span', 'field-wrap'); wrap.appendChild(input)
    row.appendChild(wrap)
    panel.appendChild(row)
  }
  const saveRow = el('div', 'enc-done')
  const save = el('button', 'btn', 'SAVE SYSTEM SETTINGS')
  save.dataset.ev = 'system-save'
  saveRow.appendChild(save)
  panel.appendChild(saveRow)

  panel.appendChild(el('div', 'lbl', 'CALIBRATION'))
  const buckets = Object.entries(state.calibration.buckets)
  if (buckets.length === 0) {
    panel.appendChild(el('div', 'dim', 'no measurements yet — the first render calibrates the cost meter'))
  } else {
    for (const [bucket, m] of buckets) {
      const row = el('div', 'insp-row')
      row.appendChild(el('span', 'insp-key', bucket))
      row.appendChild(el('span', 'insp-val', `${m.sPerStep.toFixed(1)} s/step · ${m.samples} samples · ${m.lastSession ?? ''}`))
      panel.appendChild(row)
    }
  }
  const ok = el('button', 'btn run-btn', 'START')
  ok.dataset.ev = 'close-sheet'
  panel.appendChild(ok)
  dc.nodes = { deviceIn, modelsIn, vramIn }
}

function buildPresetsSheet() {
  const dc = domCache.sheet
  const panel = sheetShell('PRESETS — optional bookmarks, never required to render')
  if (state.presets.length === 0) panel.appendChild(el('div', 'dim', 'no presets saved'))
  for (const p of state.presets) {
    const row = el('div', 'preset-row')
    row.appendChild(el('span', 'preset-name', p.name))
    row.appendChild(el('span', 'dim', p.savedAt ?? ''))
    const load = el('button', 'btn tiny', 'LOAD')
    load.dataset.ev = 'preset-load'; load.dataset.name = p.name
    const del = el('button', 'btn tiny danger', '✕')
    del.dataset.ev = 'preset-delete'; del.dataset.name = p.name
    row.appendChild(load); row.appendChild(del)
    panel.appendChild(row)
  }
  const saveRow = el('div', 'preset-save-row')
  const name = el('input', 'in-str')
  name.type = 'text'; name.placeholder = 'name this draft…'; name.dataset.ui = 'preset-name'
  const save = el('button', 'btn', 'SAVE CURRENT')
  save.dataset.ev = 'preset-save'
  saveRow.appendChild(name); saveRow.appendChild(save)
  panel.appendChild(saveRow)
  dc.nodes = { presetName: name }
}

function buildBrowseSheet(sheet) {
  const panel = sheetShell(`PICK ${sheet.field} · /${sheet.path}`)
  if (sheet.path !== '') {
    const up = el('button', 'browse-entry', '⬑ ..')
    up.dataset.ev = 'browse-entry'; up.dataset.dir = '1'
    up.dataset.path = sheet.path.includes('/') ? sheet.path.slice(0, sheet.path.lastIndexOf('/')) : ''
    panel.appendChild(up)
  }
  if (sheet.entries == null) {
    panel.appendChild(el('div', 'dim', 'listing…'))
    return
  }
  for (const entry of sheet.entries) {
    const row = el('button', 'browse-entry')
    row.dataset.ev = 'browse-entry'
    row.dataset.path = entry.path
    row.dataset.dir = entry.dir ? '1' : '0'
    if (entry.thumb) {
      const img = el('img', 'browse-thumb'); img.alt = ''; img.src = entry.thumb
      row.appendChild(img)
    }
    row.appendChild(el('span', '', `${entry.dir ? '▸ ' : ''}${entry.name}`))
    panel.appendChild(row)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: help drawer — DSL grammar, click-to-insert, searchable settings
// ════════════════════════════════════════════════════════════════════════════

const DSL_LINES = [
  ['|', 'separate prompts inside a scene', 'kelp:2 | shafts of light'],
  ['||', 'scene break — renders scenes in order', 'scene one || scene two'],
  [':2', 'weight — how hard to chase this prompt', 'kelp cathedral:2'],
  [':-1', 'negative weight — avoid this', 'watermark, text:-1'],
  [':1:200', 'weight with a stop step', 'sunrise:1:200'],
  ['_[mask.png]', 'mask this prompt to an image region', 'sky_[skymask.png]'],
  ['_r _l _u _d', 'directional half-frame masks', 'clouds_u | rocks_d'],
  ['10*sin(t/4)', 'any weight can be an expression of t', 'zoom pulse:10*sin(t/4)'],
]

function renderHelpChunk(reads) {
  const dc = domCache.help
  const open = state.ui.helpOpen
  const s = anim.springs.help
  const hidden = !open && springDone(s) && s.dest === 0
  dc.root.style.display = hidden ? 'none' : 'block'
  dc.root.style.transform = `translateX(${(1 - clamp(s.pos, 0, 1.05)) * 100}%)`
  if (hidden) { dc.key = ''; dc.tableKey = null; dc.root.textContent = ''; return }

  // shell rebuilds only when the band set changes; the settings table is its own
  // sub-projection so typing never rebuilds the search input under the cursor
  const bands = audioBandNames()
  const key = `open|${bands.join(',')}`
  if (dc.key !== key) {
    dc.key = key
    buildHelpShell(bands)
  }
  if (dc.searchNode !== reads.active) dc.searchNode.value = helpSearch
  const q = helpSearch.trim().toLowerCase()
  if (dc.tableKey !== q) {
    dc.tableKey = q
    dc.settingsTable.textContent = ''
    for (const [name, meta] of Object.entries(state.schema.fields)) {
      const text = `${name} ${meta.label ?? ''} ${meta.hint ?? ''}`.toLowerCase()
      if (q !== '' && !text.includes(q)) continue
      const row = el('button', 'help-setting')
      row.dataset.ev = 'help-setting'; row.dataset.field = name
      row.appendChild(el('span', 'insp-key', name))
      row.appendChild(el('span', 'dim', meta.hint ?? meta.label ?? ''))
      dc.settingsTable.appendChild(row)
    }
  }
}

function buildHelpShell(bands) {
  const dc = domCache.help
  dc.root.textContent = ''
  dc.tableKey = null

  const head = el('div', 'panel-head scanlines')
  head.appendChild(el('span', 'panel-title', 'HELP // DSL'))
  const close = el('button', 'btn', 'esc'); close.dataset.ev = 'close-help'
  head.appendChild(close)
  dc.root.appendChild(head)

  dc.root.appendChild(el('div', 'help-t', 't = seconds of animation time (frames elapsed ÷ frames_per_second)'))

  for (const [tok, what, example] of DSL_LINES) {
    const row = el('div', 'help-row')
    const ins = el('button', 'btn chip t-pipe', tok)
    ins.dataset.ev = 'help-insert'; ins.dataset.text = tok === '_r _l _u _d' ? '_r' : tok
    row.appendChild(ins)
    row.appendChild(el('span', 'help-what', what))
    const ex = el('button', 'help-ex', example)
    ex.dataset.ev = 'help-insert'; ex.dataset.text = example
    row.appendChild(ex)
    dc.root.appendChild(row)
  }

  dc.root.appendChild(el('div', 'lbl', 'EXPRESSION PATTERNS'))
  const chips = el('div', 'chips')
  for (const c of EXPR_PATTERN_CHIPS) {
    const chip = el('button', 'btn chip', `${c.label}: ${c.text}`)
    chip.dataset.ev = 'help-insert'; chip.dataset.text = c.text
    chips.appendChild(chip)
  }
  // audio band chips render only when input_audio_filters defines variables — never document a lie
  for (const band of bands) {
    const chip = el('button', 'btn chip t-mask', `${band}*5`)
    chip.dataset.ev = 'help-insert'; chip.dataset.text = `${band}*5`
    chips.appendChild(chip)
  }
  if (bands.length === 0) {
    const note = el('button', 'btn chip dim', 'audio bands — define in AUDIO')
    note.dataset.ev = 'bench-toggle'; note.dataset.section = 'audio'
    chips.appendChild(note)
  }
  dc.root.appendChild(chips)

  dc.root.appendChild(el('div', 'lbl', 'SETTINGS'))
  const search = el('input', 'er-search')
  search.type = 'text'; search.placeholder = '⌕ filter settings…'; search.dataset.ui = 'help-search'
  search.value = helpSearch
  dc.root.appendChild(search)
  dc.searchNode = search
  const table = el('div', 'help-settings')
  dc.root.appendChild(table)
  dc.settingsTable = table
}

// ════════════════════════════════════════════════════════════════════════════
// § CHUNK: toast + confirm — permanent nodes, content projected
// ════════════════════════════════════════════════════════════════════════════

function renderToastConfirm() {
  const dcT = domCache.toast
  const t = state.ui.toast
  if (t == null) {
    dcT.root.style.display = 'none'
    if (dcT.lastToast != null) { dcT.root.textContent = ''; dcT.lastToast = null }
  } else {
    dcT.root.style.display = 'flex'
    if (dcT.lastToast !== t) {
      dcT.lastToast = t
      dcT.root.textContent = ''
      dcT.root.className = t.text.startsWith('✕') ? 'toast danger' : 'toast'
      dcT.root.appendChild(el('span', 'toast-text', t.text))
      for (let i = 0; i < t.actions.length; i++) {
        const b = el('button', 'btn tiny', t.actions[i].label)
        b.dataset.ev = 'toast-action'; b.dataset.idx = String(i)
        dcT.root.appendChild(b)
      }
    }
  }

  const c = state.ui.confirmPending
  if (c == null) {
    dcT.confirm.style.display = 'none'
    if (dcT.lastConfirm != null) { dcT.confirm.textContent = ''; dcT.lastConfirm = null }
  } else {
    dcT.confirm.style.display = 'flex'
    if (dcT.lastConfirm !== c) {
      dcT.lastConfirm = c
      dcT.confirm.textContent = ''
      let text
      switch (c.kind) {
        case 'longRun': text = c.payload.text; break
        case 'delete': text = `delete ${c.payload}? frames, sidecar and artifacts are removed`; break
        case 'preempt': text = 'stop the live render and run now?'; break
        default: throw new Error(`unknown confirm kind ${c.kind}`)
      }
      dcT.confirm.appendChild(el('span', 'toast-text', text))
      const yes = el('button', 'btn tiny danger', 'CONFIRM'); yes.dataset.ev = 'confirm-yes'
      const no = el('button', 'btn tiny', 'CANCEL'); no.dataset.ev = 'confirm-no'
      dcT.confirm.appendChild(yes); dcT.confirm.appendChild(no)
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § BOOT — all initialization upfront; first paint uses the same data flow
// ════════════════════════════════════════════════════════════════════════════

async function boot() {
  const [schema, draft, sessions, calibration, queue, presets, health] = await Promise.all([
    api('GET', '/api/schema'),
    api('GET', '/api/draft'),
    api('GET', '/api/sessions'),
    api('GET', '/api/calibration'),
    api('GET', '/api/queue'),
    api('GET', '/api/presets'),
    api('GET', '/api/health'),
  ])
  state.schema = validateSchema(schema)
  state.calibration = { buckets: req(calibration, 'buckets', 'object', '/api/calibration') }
  state.health = health

  const values = req(draft, 'values', 'object', '/api/draft')
  state.draft.values = { ...schemaDefaults(), ...values }
  state.draft.forkOf = draft.forkOf ?? null
  state.draft.seedLocked = draft.seedLocked === true

  const list = req(sessions, 'sessions', 'array', '/api/sessions').map(validateSessionSummary)
  const byId = {}
  const order = []
  for (const s of list) { byId[s.id] = s; order.push(s.id) }
  state.sessions = { byId, order }

  // adopt a render already in flight (boot mid-render, e.g. a reload)
  const running = list.find((s) => s.state === 'rendering')
  if (running != null) {
    state.live.sessionId = running.id
    state.live.state = 'rendering'
    state.live.step = running.stepsDone
    state.live.stepsTotal = running.stepsTotal
    state.live.frames = running.frames
    state.live.seed = running.seed ?? null
  }

  state.queue = queue.queued ?? null
  state.presets = req(presets, 'presets', 'array', '/api/presets')

  state.firstBoot = order.length === 0 && Object.keys(state.calibration.buckets).length === 0
  if (state.firstBoot) state.ui.sheet = { kind: 'firstBoot' }

  buildBench()
  registerEvents()
  openSse()
  runPreflight()   // initial estimate feeds the cost meter, TIME readouts, EXPR t-range
  scheduleRender()
}

boot()

// console debug handle (module scope is otherwise unreachable from devtools)
window.__pytti = { state, anim, domCache, fx }
