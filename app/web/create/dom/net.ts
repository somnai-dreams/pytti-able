// net.ts — every network effect: fetch wrappers (all bodies parsed through core/api,
// which throws on boundary violations) and the EventSource lifecycle. Expected,
// recoverable outcomes (400 preflight, 400 draft coercion, 400 encode) come back as
// data; unexpected statuses and malformed bodies throw.
import {
  parseEncodeStart,
  parseErrorBody,
  parseQueue,
  parseSchemaFields,
  parseSessionDetail,
  parseSessions,
  parseSseEvent,
  parseStartResult,
  parseUploadResult,
  type StartResult,
} from '../core/api'
import type { QueueSlot, SseEvent, Tile } from '../core/model'
import type { DraftPayload } from '../core/presets'

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${parseErrorBody(await res.json())}`)
  return res.json()
}

export async function getSessions(): Promise<Tile[]> {
  return parseSessions(await getJson('/api/sessions'))
}

export async function getSessionDetail(id: string): Promise<{ tile: Tile; config: Record<string, unknown> }> {
  return parseSessionDetail(await getJson(`/api/sessions/${id}`))
}

export async function getQueue(): Promise<QueueSlot | null> {
  return parseQueue(await getJson('/api/queue'))
}

export async function getSchemaFields(): Promise<string[]> {
  return parseSchemaFields(await getJson('/api/schema'))
}

export type PutDraftResult = { ok: true } | { ok: false; message: string }

export async function putDraft(payload: DraftPayload): Promise<PutDraftResult> {
  const res = await fetch('/api/draft', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.status === 204) return { ok: true }
  if (res.status === 400) return { ok: false, message: parseErrorBody(await res.json()) }
  throw new Error(`PUT /api/draft -> unexpected status ${res.status}`)
}

// Create always uses queue mode: idle -> starts immediately; busy -> the one-slot queue.
// Never preempt from Create — killing a live render is a bench verb.
export async function postStart(): Promise<StartResult> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'queue' }),
  })
  return parseStartResult(res.status, await res.json())
}

export async function deleteQueue(): Promise<void> {
  const res = await fetch('/api/queue', { method: 'DELETE' })
  if (res.status !== 204) throw new Error(`DELETE /api/queue -> unexpected status ${res.status}`)
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
  if (res.status !== 204) throw new Error(`DELETE /api/sessions/${id} -> ${res.status}: ${parseErrorBody(await res.json())}`)
}

export type UploadResult = { ok: true; path: string } | { ok: false; message: string }

// POST /api/uploads (multipart) — the one non-JSON request body in the app. A non-200
// is expected-recoverable data (the attach/save flows toast it); network refusal throws
// and the callers map it to the 'upload failed' toast (ruling 6).
export async function uploadFile(data: Blob, name: string): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', data, name)
  const res = await fetch('/api/uploads', { method: 'POST', body: form })
  if (res.status === 200) return { ok: true, path: parseUploadResult(await res.json()) }
  return { ok: false, message: parseErrorBody(await res.json()) }
}

export type EncodeResult = { ok: true; jobId: string } | { ok: false; message: string }

export async function postEncode(id: string): Promise<EncodeResult> {
  const res = await fetch(`/api/sessions/${id}/encode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}), // server defaults fps/format
  })
  if (res.status === 201) return { ok: true, jobId: parseEncodeStart(await res.json()) }
  if (res.status === 400) return { ok: false, message: parseErrorBody(await res.json()) }
  throw new Error(`POST /api/sessions/${id}/encode -> unexpected status ${res.status}`)
}

// One EventSource for the page's lifetime. The browser reconnects on its own with
// Last-Event-ID replay, but the replay ring is bounded (1000 entries) — the snapshot is
// truth, SSE is deltas — so onOpen must resync REST state after every retry.
export function openEvents(handlers: {
  onEvent: (ev: SseEvent) => void
  onOpen: () => void
  onError: () => void
}): void {
  const source = new EventSource('/api/events')
  for (const type of ['state', 'progress', 'frame', 'queue', 'encode'] as const) {
    source.addEventListener(type, (e: MessageEvent) => {
      handlers.onEvent(parseSseEvent(type, JSON.parse(e.data as string)))
    })
  }
  source.onopen = () => handlers.onOpen()
  source.onerror = () => handlers.onError()
}
