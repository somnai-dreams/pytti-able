"""
Server tests for POST /api/sessions submission paths and the FIFO render queue
(stdlib unittest, in-process: requests run through the real Handler over a fake
socket, no port is ever bound — never touches a live STUDIO).

Invariants under test:
- §5.6 isolation: a self-contained submission ({values, forkOf?, seedLocked?})
  composes config/default.yaml over schema defaults + the caller's values and
  NEVER reads or writes the shared draft; a body without "values" keeps the
  draft-based behavior byte-identical (the bench's path), and the draft is
  composed AT ENQUEUE — later draft edits never mutate a queued item.
- The queue is a real FIFO (§2.5): mode 'queue' APPENDS (cap QUEUE_CAP,
  over-cap -> 400, nothing evicted), per-item cancel renumbers, the head
  auto-starts on any terminal render via peek->commit (it stays in the queue —
  cancellable, FIFO-visible, id-taken — until the spawn commits under the
  lock), a head that fails preflight at start surfaces as a failed session
  without wedging the queue (even when preflight raises or the failure record
  cannot be written), and preempt parks at the head with the rest of the queue
  intact behind it, REPLACING a previous still-parked preemptor.
- STOP is first-class (POST /api/sessions/{id}/stop): the running render lands
  'stopped' keeping its frames and config snapshot (tweak/re-run capable), the
  FIFO auto-advances exactly like natural completion, double-stop is idempotent,
  and stop-with-nothing-running is a clean 404. The stop/finalize ordering is
  pinned: the 'stopping' write happens under the manager lock (a stop landing as
  the render exits naturally can never revert the terminal record), pump phase
  announces are dropped once stop is requested, and the next spawn starts with a
  clean stop_requested flag.
- Two-phase sessions (§16): the 'underpaint' envelope field (self-contained path
  only — the draft can never carry it), the phase-1 derivation (source overrides
  + the UNDERPAINT_NEUTRAL strip list, enumerated), the handoff (same session id,
  no terminal state between phases, init injection, c2f backstop), stop/failure
  per phase with queue advance, one-item queueing, preempt, both resume rows,
  the mask composite math + missing-mask fail-loud, and the underpaint frame
  route's path containment.

Run: .venv/bin/python app/test_server.py
"""

from __future__ import annotations

import io
import json
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import server  # noqa: E402


class FakeSocket:
    """Just enough socket for BaseHTTPRequestHandler: rfile via makefile('rb'),
    wfile via sendall (socketserver._SocketWriter)."""

    def __init__(self, request_bytes: bytes):
        self._in = io.BytesIO(request_bytes)
        self.out = io.BytesIO()

    def makefile(self, mode, *args, **kwargs):
        assert mode == "rb", mode
        return self._in

    def sendall(self, data):
        self.out.write(data)


class DummyServer:
    pass


def http(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    """Drive one request through the real Handler in-process; parse the response."""
    payload = b"" if body is None else json.dumps(body).encode()
    lines = [f"{method} {path} HTTP/1.1", "Host: test"]
    if body is not None:
        lines += ["Content-Type: application/json", f"Content-Length: {len(payload)}"]
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode() + payload
    sock = FakeSocket(raw)
    server.Handler(sock, ("127.0.0.1", 0), DummyServer())
    response = sock.out.getvalue()
    head, _, resp_body = response.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    parsed = json.loads(resp_body) if resp_body else {}
    return status, parsed


VALID_VALUES = {"scenes": "an isolation test prompt", "width": 256, "height": 256}


class SessionsPostBase(unittest.TestCase):
    """Stub the render manager (nothing may spawn) and sandbox the draft file."""

    def setUp(self):
        self.calls: list[tuple] = []

        def fake_start(values, fork_of, seed_locked, underpaint=None):
            self.calls.append(("start", values, fork_of, seed_locked, underpaint))
            return "s-9999-test", 1234

        def fake_enqueue(values, fork_of, seed_locked, underpaint=None):
            self.calls.append(("enqueue", values, fork_of, seed_locked, underpaint))
            return {"queuedId": "s-9999-test", "position": 1}

        server.MANAGER.start = fake_start
        server.MANAGER.enqueue = fake_enqueue

        self._tmp = tempfile.TemporaryDirectory()
        self._draft_orig = server.DRAFT_PATH
        server.DRAFT_PATH = Path(self._tmp.name) / "draft.yaml"

    def tearDown(self):
        del server.MANAGER.start  # instance attrs; deleting restores the real methods
        del server.MANAGER.enqueue
        server.DRAFT_PATH = self._draft_orig
        self._tmp.cleanup()

    # helpers ---------------------------------------------------------------

    def seed_draft(self, values: dict, fork_of=None, seed_locked=False):
        server.write_draft({"values": values, "forkOf": fork_of, "seedLocked": seed_locked})

    def draft_fingerprint(self) -> tuple[bytes, float]:
        stat = server.DRAFT_PATH.stat()
        return server.DRAFT_PATH.read_bytes(), stat.st_mtime_ns

    def started_values(self) -> dict:
        self.assertEqual(len(self.calls), 1, self.calls)
        return self.calls[0][1]


class TestSelfContainedPath(SessionsPostBase):
    def test_composes_defaults_plus_values(self):
        status, resp = http("POST", "/api/sessions", {"mode": "now", "values": dict(VALID_VALUES)})
        self.assertEqual(status, 201)
        self.assertEqual(resp, {"sessionId": "s-9999-test", "seed": 1234})
        values = self.started_values()
        # the caller's values won
        self.assertEqual(values["scenes"], VALID_VALUES["scenes"])
        self.assertEqual(values["width"], 256)
        # the versioned tuned defaults (config/default.yaml) fill everything else
        defaults = server.tuned_defaults()
        self.assertEqual(values["cutouts"], defaults["cutouts"])
        self.assertEqual(values["image_model"], defaults["image_model"])
        self.assertEqual(values["smoothing_weight"], defaults["smoothing_weight"])
        # composition base is defaults, not the draft: every schema field is present
        self.assertEqual(set(values), set(defaults))

    def test_bare_submission_composes_engine_default_experiments(self):
        # The cross-layer pin behind the EXPERIMENTS panel's payload rule (spec
        # §5.7): Create's untouched panel emits ZERO keys for six of its seven rows
        # because the server's defaults-compose already produces exactly these
        # values. If a future default.yaml flip breaks the equivalence (say
        # cutout_sampler goes 'full' or auto_stop goes true), the untouched panel
        # would silently stop meaning what its chips show — this test names the
        # flipped field before that can ship.
        status, _ = http("POST", "/api/sessions", {"mode": "now", "values": dict(VALID_VALUES)})
        self.assertEqual(status, 201)
        values = self.started_values()
        self.assertEqual(values["init_spectrum"], "white")
        self.assertEqual(values["init_spectrum_chroma"], "full")
        self.assertIs(values["coarse_to_fine"], False)
        self.assertIs(values["coherence_weighting"], False)
        self.assertEqual(values["cutout_sampler"], "smart")
        self.assertIs(values["phase_scheduling"], False)
        self.assertIs(values["auto_stop"], False)
        self.assertIs(values["structure_annealing"], False)

    def test_draft_is_never_read_or_written(self):
        # a poisoned draft (the smoothing_weight contamination class) must not leak in,
        # and the file must be byte- and mtime-identical afterwards
        self.seed_draft({"scenes": "poisoned draft", "smoothing_weight": 99.0}, fork_of="s-0001-x")
        before = self.draft_fingerprint()
        status, _ = http("POST", "/api/sessions", {"mode": "now", "values": dict(VALID_VALUES)})
        self.assertEqual(status, 201)
        self.assertEqual(self.draft_fingerprint(), before)
        values = self.started_values()
        self.assertEqual(values["scenes"], VALID_VALUES["scenes"])
        self.assertEqual(values["smoothing_weight"], server.tuned_defaults()["smoothing_weight"])
        self.assertIsNone(self.calls[0][2])  # forkOf comes from the body, not the draft

    def test_unknown_config_field_400(self):
        status, resp = http("POST", "/api/sessions",
                            {"mode": "now", "values": {**VALID_VALUES, "nonsense_field": 1}})
        self.assertEqual(status, 400)
        self.assertIn("nonsense_field", resp["error"])
        self.assertEqual(self.calls, [])

    def test_unknown_envelope_field_400(self):
        status, resp = http("POST", "/api/sessions",
                            {"mode": "now", "values": dict(VALID_VALUES), "bogus": True})
        self.assertEqual(status, 400)
        self.assertIn("bogus", resp["error"])
        self.assertEqual(self.calls, [])

    def test_non_object_values_400(self):
        status, _ = http("POST", "/api/sessions", {"mode": "now", "values": [1, 2]})
        self.assertEqual(status, 400)
        self.assertEqual(self.calls, [])

    def test_mistyped_field_coercion_400(self):
        status, resp = http("POST", "/api/sessions",
                            {"mode": "now", "values": {**VALID_VALUES, "width": "not a number"}})
        self.assertEqual(status, 400)
        self.assertIn("width", resp["error"])
        self.assertEqual(self.calls, [])

    def test_coercion_parses_string_numbers(self):
        status, _ = http("POST", "/api/sessions",
                         {"mode": "now", "values": {**VALID_VALUES, "width": "320", "height": "180"}})
        self.assertEqual(status, 201)
        self.assertEqual(self.started_values()["width"], 320)
        self.assertEqual(self.started_values()["height"], 180)

    def test_preflight_still_fires(self):
        status, resp = http("POST", "/api/sessions", {"mode": "now", "values": {"scenes": "   "}})
        self.assertEqual(status, 400)
        self.assertEqual(resp["error"], "preflight failed")
        self.assertTrue(any(i["field"] == "scenes" for i in resp["issues"]))
        self.assertEqual(self.calls, [])

    def test_fork_and_seed_lock_ride_the_body(self):
        status, _ = http("POST", "/api/sessions", {
            "mode": "now",
            "values": {**VALID_VALUES, "seed": 42},
            "forkOf": "s-0007-parent",
            "seedLocked": True,
        })
        self.assertEqual(status, 201)
        kind, values, fork_of, seed_locked, underpaint = self.calls[0]
        self.assertEqual(kind, "start")
        self.assertEqual(values["seed"], 42)
        self.assertEqual(fork_of, "s-0007-parent")
        self.assertIs(seed_locked, True)
        self.assertIsNone(underpaint)  # absent envelope field -> no two-phase behavior

    def test_mistyped_fork_and_seed_lock_400(self):
        status, _ = http("POST", "/api/sessions",
                         {"values": dict(VALID_VALUES), "forkOf": 7})
        self.assertEqual(status, 400)
        status, _ = http("POST", "/api/sessions",
                         {"values": dict(VALID_VALUES), "seedLocked": "yes"})
        self.assertEqual(status, 400)
        self.assertEqual(self.calls, [])

    def test_queue_mode_reaches_enqueue(self):
        status, resp = http("POST", "/api/sessions", {"mode": "queue", "values": dict(VALID_VALUES)})
        self.assertEqual(status, 202)
        self.assertEqual(resp, {"queuedId": "s-9999-test", "position": 1})
        self.assertNotIn("replaced", resp)  # the one-slot replace contract is dead
        self.assertEqual(self.calls[0][0], "enqueue")


class TestDraftBasedPathRegression(SessionsPostBase):
    """The bench's path: any POST body without "values" behaves exactly as before."""

    def test_bodyless_post_reads_the_draft(self):
        self.seed_draft({"scenes": "bench draft prompt", "steps_per_scene": 321},
                        fork_of="s-0002-base", seed_locked=True)
        status, resp = http("POST", "/api/sessions")  # no body at all
        self.assertEqual(status, 201)
        self.assertEqual(resp, {"sessionId": "s-9999-test", "seed": 1234})
        kind, values, fork_of, seed_locked, underpaint = self.calls[0]
        self.assertEqual(kind, "start")
        self.assertIsNone(underpaint)  # the draft path can never be two-phase (§16)
        self.assertEqual(values["scenes"], "bench draft prompt")
        self.assertEqual(values["steps_per_scene"], 321)
        # draft values merge OVER tuned defaults, exactly as before
        self.assertEqual(values["cutouts"], server.tuned_defaults()["cutouts"])
        self.assertEqual(fork_of, "s-0002-base")
        self.assertIs(seed_locked, True)

    def test_mode_only_body_reads_the_draft(self):
        self.seed_draft({"scenes": "bench draft prompt"})
        status, _ = http("POST", "/api/sessions", {"mode": "queue"})
        self.assertEqual(status, 202)
        kind, values, _, _, _ = self.calls[0]
        self.assertEqual(kind, "enqueue")
        self.assertEqual(values["scenes"], "bench draft prompt")

    def test_draft_path_preflight_still_fires(self):
        self.seed_draft({"scenes": ""})
        status, resp = http("POST", "/api/sessions", {"mode": "now"})
        self.assertEqual(status, 400)
        self.assertEqual(resp["error"], "preflight failed")
        self.assertEqual(self.calls, [])

    def test_put_draft_still_writes(self):
        status, _ = http("PUT", "/api/draft", {"values": {"scenes": "bench edit", "width": 512}})
        self.assertEqual(status, 204)
        draft = server.read_draft()
        self.assertEqual(draft["values"]["scenes"], "bench edit")


class FakeProc:
    """Sentinel standing in for a live subprocess: MANAGER checks `is not None`;
    stop()'s SIGTERM enforcer also calls wait(). The pid is an arbitrary sentinel,
    NOT protection — Linux pid_max can exceed any constant — so tests routing
    through the real MANAGER.stop monkeypatch os.killpg (TestStopEndpoint.setUp)
    instead of trusting the pid to be unused."""
    pid = 424242

    def wait(self, timeout=None):
        return 0


class QueueBase(unittest.TestCase):
    """A FRESH RenderManager swapped in for the global (the Handler routes to
    server.MANAGER), draft + outputs sandboxed to a temp dir."""

    def setUp(self):
        self.manager = server.RenderManager()
        self._orig_manager = server.MANAGER
        server.MANAGER = self.manager

        self._tmp = tempfile.TemporaryDirectory()
        self._draft_orig = server.DRAFT_PATH
        server.DRAFT_PATH = Path(self._tmp.name) / "draft.yaml"
        self._outputs_orig = server.OUTPUTS_DIR
        server.OUTPUTS_DIR = Path(self._tmp.name) / "outputs"
        server.OUTPUTS_DIR.mkdir()
        self._store_ids_before = set(server.STORE.sessions)

    def tearDown(self):
        server.MANAGER = self._orig_manager
        server.DRAFT_PATH = self._draft_orig
        server.OUTPUTS_DIR = self._outputs_orig
        for sid in set(server.STORE.sessions) - self._store_ids_before:
            server.STORE.sessions.pop(sid, None)
        self._tmp.cleanup()

    def make_busy(self, live_id="s-8000-live"):
        self.manager.proc = FakeProc()
        self.manager.live_id = live_id

    def queue_ids(self):
        return [item["id"] for item in self.manager.queue]


class TestQueueHttpContract(QueueBase):
    def test_202_carries_queue_id_and_position_appending(self):
        self.make_busy()
        status, first = http("POST", "/api/sessions", {"mode": "queue", "values": dict(VALID_VALUES)})
        self.assertEqual(status, 202)
        self.assertEqual(set(first), {"queuedId", "position"})
        self.assertEqual(first["position"], 1)
        status, second = http("POST", "/api/sessions",
                              {"mode": "queue", "values": {**VALID_VALUES, "scenes": "second prompt"}})
        self.assertEqual(status, 202)
        self.assertEqual(second["position"], 2)
        self.assertNotEqual(first["queuedId"], second["queuedId"])
        # append, never replace: both items live, FIFO order
        self.assertEqual(self.queue_ids(), [first["queuedId"], second["queuedId"]])

    def test_get_queue_returns_tile_ready_items_in_order(self):
        self.make_busy()
        http("POST", "/api/sessions", {"mode": "queue", "values": dict(VALID_VALUES)})
        http("POST", "/api/sessions", {"mode": "queue", "values": {**VALID_VALUES, "scenes": "second prompt", "width": 640, "height": 360}})
        status, resp = http("GET", "/api/queue")
        self.assertEqual(status, 200)
        items = resp["items"]
        self.assertEqual(len(items), 2)
        for n, item in enumerate(items):
            self.assertEqual(set(item), {"id", "position", "slug", "scenes", "width", "height", "stepsPerScene", "enqueuedAt"})
            self.assertEqual(item["position"], n + 1)
        self.assertEqual(items[0]["scenes"], VALID_VALUES["scenes"])
        self.assertEqual(items[1]["width"], 640)
        self.assertEqual(items[1]["height"], 360)

    def test_cap_enforced_400_nothing_evicted(self):
        self.make_busy()
        for n in range(server.QUEUE_CAP):
            status, _ = http("POST", "/api/sessions",
                             {"mode": "queue", "values": {**VALID_VALUES, "scenes": f"prompt {n}"}})
            self.assertEqual(status, 202)
        head = self.queue_ids()[0]
        status, resp = http("POST", "/api/sessions", {"mode": "queue", "values": dict(VALID_VALUES)})
        self.assertEqual(status, 400)
        self.assertIn(str(server.QUEUE_CAP), resp["error"])
        self.assertEqual(len(self.manager.queue), server.QUEUE_CAP)
        self.assertEqual(self.queue_ids()[0], head)  # nothing evicted

    def test_cancel_by_id_renumbers(self):
        self.make_busy()
        ids = []
        for n in range(3):
            _, resp = http("POST", "/api/sessions",
                           {"mode": "queue", "values": {**VALID_VALUES, "scenes": f"prompt {n}"}})
            ids.append(resp["queuedId"])
        status, _ = http("DELETE", f"/api/queue/{ids[1]}")
        self.assertEqual(status, 204)
        _, resp = http("GET", "/api/queue")
        self.assertEqual([i["id"] for i in resp["items"]], [ids[0], ids[2]])
        self.assertEqual([i["position"] for i in resp["items"]], [1, 2])

    def test_cancel_unknown_id_404_and_never_touches_live(self):
        self.make_busy(live_id="s-8000-live")
        status, _ = http("DELETE", "/api/queue/s-8000-live")
        self.assertEqual(status, 404)
        self.assertIsNotNone(self.manager.proc)  # the running render is untouched

    def test_mode_now_busy_409_unchanged(self):
        self.make_busy(live_id="s-8000-live")
        status, resp = http("POST", "/api/sessions", {"mode": "now", "values": dict(VALID_VALUES)})
        self.assertEqual(status, 409)
        self.assertEqual(resp["live"], "s-8000-live")

    def test_queue_mode_idle_starts_immediately(self):
        started = []

        def fake_spawn(values, fork_of, seed_locked, session_id=None, underpaint=None):
            started.append(values)
            self.manager.proc = FakeProc()
            return "s-9999-test", 1234, FakeProc()

        self.manager._spawn_locked = fake_spawn
        self.manager._announce_spawn = lambda sid, seed, proc: None
        status, resp = http("POST", "/api/sessions", {"mode": "queue", "values": dict(VALID_VALUES)})
        self.assertEqual(status, 201)
        # exact wire shape — the spec table (§2.4) documents 201 as {sessionId, seed};
        # internal discriminators must not leak
        self.assertEqual(set(resp), {"sessionId", "seed"})
        self.assertEqual(resp["sessionId"], "s-9999-test")
        self.assertEqual(resp["seed"], 1234)
        self.assertEqual(len(started), 1)
        self.assertEqual(self.manager.queue, [])

    def test_draft_composed_at_enqueue_not_at_start(self):
        # A bodyless bench submission freezes the draft into the queue item; a later
        # draft edit must not reach it (self-contained items, §5.6).
        self.make_busy()
        server.write_draft({"values": {"scenes": "the draft at enqueue time"}, "forkOf": None, "seedLocked": False})
        status, _ = http("POST", "/api/sessions", {"mode": "queue"})
        self.assertEqual(status, 202)
        status, _ = http("PUT", "/api/draft", {"values": {"scenes": "edited AFTER enqueue"}})
        self.assertEqual(status, 204)
        item = self.manager.queue[0]
        self.assertEqual(item["values"]["scenes"], "the draft at enqueue time")

    def test_queue_items_are_self_contained(self):
        self.make_busy()
        status, _ = http("POST", "/api/sessions", {
            "mode": "queue",
            "values": {**VALID_VALUES, "seed": 42},
            "forkOf": "s-0007-parent",
            "seedLocked": True,
        })
        self.assertEqual(status, 202)
        item = self.manager.queue[0]
        # the FULL composed submission is frozen on the item, not a reference to shared state
        self.assertEqual(set(item["values"]), set(server.tuned_defaults()))
        self.assertEqual(item["values"]["seed"], 42)
        self.assertEqual(item["forkOf"], "s-0007-parent")
        self.assertIs(item["seedLocked"], True)
        self.assertIsInstance(item["enqueuedAt"], int)


class TestQueueAutoStart(QueueBase):
    """Drive the render-exit path (_finalize) against a stubbed spawn. _start_next
    commits the head via _spawn_locked UNDER the lock (peek->commit, no pop->spawn
    window), so that is the seam to stub."""

    LIVE = "s-8000-live"

    def setUp(self):
        super().setUp()
        self.started: list[tuple] = []

        def fake_spawn_locked(values, fork_of, seed_locked, session_id=None, underpaint=None):
            self.started.append((values, fork_of, seed_locked, session_id))
            self.manager.proc = FakeProc()
            self.manager.live_id = session_id
            return session_id, 1234, FakeProc()

        self.manager._spawn_locked = fake_spawn_locked
        self.manager._announce_spawn = lambda sid, seed, proc: None

    def seed_live_session(self):
        """A finished-render fixture: STORE record + manager live state, so the real
        _finalize can run end to end."""
        (server.OUTPUTS_DIR / self.LIVE).mkdir(parents=True, exist_ok=True)
        server.STORE.put({
            "schemaVersion": 1, "id": self.LIVE, "slug": "live", "state": "rendering",
            "seed": 1, "startedAt": server.now_ms(), "stepsDone": 0, "stepsTotal": 100,
            "frames": 0, "forkedFrom": None, "artifacts": [], "config": {"scenes": "live"},
        })
        self.make_busy(self.LIVE)
        self.manager.started_at = time.time()

    def enqueue_while_busy(self, scenes: str) -> str:
        result = self.manager.enqueue({"scenes": scenes, "width": 256, "height": 256}, None, False)
        return result["queuedId"]

    def finalize_live(self, exit_code: int):
        self.manager._finalize(self.LIVE, exit_code, [])

    def test_autostart_on_completion(self):
        self.seed_live_session()
        a = self.enqueue_while_busy("queued item a")
        b = self.enqueue_while_busy("queued item b")
        self.finalize_live(0)
        self.assertEqual(len(self.started), 1)
        values, fork_of, seed_locked, session_id = self.started[0]
        self.assertEqual(session_id, a)  # the item keeps its pre-minted id
        self.assertEqual(values["scenes"], "queued item a")
        self.assertEqual(self.queue_ids(), [b])  # b waits its turn

    def test_autostart_on_failure_too(self):
        self.seed_live_session()
        a = self.enqueue_while_busy("queued item a")
        self.finalize_live(1)  # the live render FAILED — the queue still drains
        self.assertEqual(server.STORE.sessions[self.LIVE]["state"], "failed")
        self.assertEqual([s[3] for s in self.started], [a])

    def test_preflight_failure_at_start_does_not_wedge(self):
        self.seed_live_session()
        with self.manager._lock:
            bad = self.manager._make_item({"scenes": "   "}, None, False)  # fails preflight
            self.manager.queue.append(bad)
        good = self.enqueue_while_busy("good prompt behind the bad one")
        self.finalize_live(0)
        # the bad item surfaced as a failed session…
        failed = server.STORE.sessions[bad["id"]]
        self.assertEqual(failed["state"], "failed")
        self.assertTrue(any("scenes" in line for line in failed["failExcerpt"]))
        # …and the good one started anyway
        self.assertEqual([s[3] for s in self.started], [good])
        self.assertEqual(self.queue_ids(), [])

    def test_cancel_then_finalize_never_starts_the_cancelled_item(self):
        self.seed_live_session()
        a = self.enqueue_while_busy("will be cancelled")
        b = self.enqueue_while_busy("stays")
        self.manager.cancel_queued(a)
        self.finalize_live(0)
        self.assertEqual([s[3] for s in self.started], [b])

    def test_manual_start_winning_the_window_leaves_the_head_queued(self):
        # A manual start committing during the peek->commit window (preflight runs
        # outside the lock) must neither lose the head nor start it — it was never
        # popped, so it simply stays queued for the next _finalize.
        self.seed_live_session()
        a = self.enqueue_while_busy("raced item")
        b = self.enqueue_while_busy("behind it")
        real_preflight = server.preflight

        def manual_start_lands_mid_preflight(values):
            self.manager.proc = FakeProc()  # a mode:'now' start commits while we preflight
            self.manager.live_id = "s-8001-manual"
            return real_preflight(values)

        server.preflight = manual_start_lands_mid_preflight
        try:
            self.finalize_live(0)
        finally:
            server.preflight = real_preflight
        self.assertEqual(self.started, [])  # the head did NOT start under the winner
        self.assertEqual(self.queue_ids(), [a, b])  # still queued, order intact

    def test_cancel_during_the_start_window_never_resurrects_the_item(self):
        # DELETE /api/queue/{id} landing in the peek->commit window: the head is
        # still IN the queue (peeked, not popped), so the cancel reaches it and it
        # must never start or reappear — the next item drains instead.
        self.seed_live_session()
        a = self.enqueue_while_busy("cancelled mid-window")
        b = self.enqueue_while_busy("next up")
        real_preflight = server.preflight
        fired = []

        def cancel_lands_mid_preflight(values):
            if not fired:
                fired.append(True)
                self.manager.cancel_queued(a)
            return real_preflight(values)

        server.preflight = cancel_lands_mid_preflight
        try:
            self.finalize_live(0)
        finally:
            server.preflight = real_preflight
        self.assertEqual([s[3] for s in self.started], [b])
        self.assertEqual(self.queue_ids(), [])

    def test_latecomer_enqueue_during_the_start_window_appends_not_starts(self):
        # A {mode:'queue'} POST landing in the peek->commit window sees a non-empty
        # queue (the head is still in it) — it APPENDS behind the item that waited
        # its FIFO turn, never jumps it, and its minted id can never collide with
        # the head's pre-minted id.
        self.seed_live_session()
        a = self.enqueue_while_busy("waited its turn")
        results = []
        real_preflight = server.preflight

        def latecomer_lands_mid_preflight(values):
            if not results:
                results.append(self.manager.enqueue(
                    {"scenes": "latecomer", "width": 256, "height": 256}, None, False))
            return real_preflight(values)

        server.preflight = latecomer_lands_mid_preflight
        try:
            self.finalize_live(0)
        finally:
            server.preflight = real_preflight
        self.assertEqual(set(results[0]), {"queuedId", "position"})  # appended, NOT started
        self.assertEqual(results[0]["position"], 2)
        self.assertNotEqual(results[0]["queuedId"], a)  # head's id stayed taken for mint
        self.assertEqual([s[3] for s in self.started], [a])  # FIFO respected
        self.assertEqual(self.queue_ids(), [results[0]["queuedId"]])

    def test_preflight_exception_fails_the_item_and_drains_on(self):
        # preflight RAISING (not just returning not-ok) must be contained per item:
        # the drain runs on the pump thread and an escape wedges every queued render.
        self.seed_live_session()
        a = self.enqueue_while_busy("preflight blows up on me")
        b = self.enqueue_while_busy("still starts")
        real_preflight = server.preflight

        def exploding_preflight(values):
            if values["scenes"] == "preflight blows up on me":
                raise OSError(5, "Input/output error")
            return real_preflight(values)

        server.preflight = exploding_preflight
        try:
            self.finalize_live(0)  # must not raise
        finally:
            server.preflight = real_preflight
        self.assertEqual(server.STORE.sessions[a]["state"], "failed")
        self.assertTrue(any("OSError" in line for line in server.STORE.sessions[a]["failExcerpt"]))
        self.assertEqual([s[3] for s in self.started], [b])

    def test_failure_record_error_does_not_wedge_the_drain(self):
        # Disk full while writing the failed-session record (_fail_queued_item ->
        # STORE.put) must not unwind the pump thread — the next item still starts.
        self.seed_live_session()
        with self.manager._lock:
            bad = self.manager._make_item({"scenes": "   "}, None, False)  # fails preflight
            self.manager.queue.append(bad)
        good = self.enqueue_while_busy("still starts")

        def enospc_put(session):
            raise OSError(28, "No space left on device")

        server.STORE.put = enospc_put
        try:
            self.finalize_live(0)  # must not raise
        finally:
            del server.STORE.put  # instance attr; deleting restores the real method
        self.assertEqual([s[3] for s in self.started], [good])
        self.assertEqual(self.queue_ids(), [])

    def test_preempt_parks_at_head_queue_intact(self):
        self.seed_live_session()
        a = self.enqueue_while_busy("queued a")
        b = self.enqueue_while_busy("queued b")
        stopped = []
        self.manager.stop = lambda sid: stopped.append(sid)
        result = self.manager.preempt({"scenes": "jump the line", "width": 256, "height": 256}, None, False)
        self.assertEqual(stopped, [self.LIVE])
        self.assertEqual(result["preempting"], self.LIVE)
        self.assertEqual(result["position"], 1)
        self.assertEqual(self.queue_ids(), [result["queuedId"], a, b])
        # the preemptor starts when the killed render finalizes; the rest stay behind it
        self.finalize_live(1)
        self.assertEqual([s[3] for s in self.started], [result["queuedId"]])
        self.assertEqual(self.queue_ids(), [a, b])

    def test_preempt_during_the_stop_window_replaces_not_stacks(self):
        # The live render takes up to 5s to die (SIGTERM grace); impatient repeat
        # preempts in that window must REPLACE the parked preemptor, not stack N
        # unwanted full renders (and must not grow the queue past cap+1).
        self.seed_live_session()
        a = self.enqueue_while_busy("queued a")
        self.manager.stop = lambda sid: None  # the render lingers in its grace period
        self.manager.preempt({"scenes": "preempt one", "width": 256, "height": 256}, None, False)
        p2 = self.manager.preempt({"scenes": "preempt two", "width": 256, "height": 256}, None, False)
        p3 = self.manager.preempt({"scenes": "preempt three", "width": 256, "height": 256}, None, False)
        self.assertEqual(p3["position"], 1)
        self.assertEqual(self.queue_ids(), [p3["queuedId"], a])  # ONE slot, newest wins
        self.assertNotEqual(p2["queuedId"], p3["queuedId"])
        self.finalize_live(1)
        self.assertEqual([s[3] for s in self.started], [p3["queuedId"]])
        self.assertEqual(self.queue_ids(), [a])

    def test_preempt_replacement_scope_ends_when_the_preemptor_starts(self):
        # Once the parked preemptor has started, a later preempt targets the NEW live
        # render and must park in front of the ordinary queue, replacing nothing.
        self.seed_live_session()
        a = self.enqueue_while_busy("queued a")
        self.manager.stop = lambda sid: None
        p1 = self.manager.preempt({"scenes": "preempt one", "width": 256, "height": 256}, None, False)
        self.finalize_live(1)  # p1 starts; queue is [a] again
        self.assertEqual([s[3] for s in self.started], [p1["queuedId"]])
        p2 = self.manager.preempt({"scenes": "preempt two", "width": 256, "height": 256}, None, False)
        self.assertEqual(p2["preempting"], p1["queuedId"])
        self.assertEqual(self.queue_ids(), [p2["queuedId"], a])  # a survives — no replace


class TestStopEndpoint(QueueBase):
    """POST /api/sessions/{id}/stop — stop-anytime, first-class (2026-08-05; the
    endpoint predates Create as the bench's STOP; these tests pin the contract
    Create's ◼ STOP tile control relies on): 202 {stopping}; the session finalizes
    'stopped' KEEPING every frame rendered so far (gallery-visible, tweak/re-run
    capable via its intact config snapshot); the FIFO auto-advances exactly like
    natural completion; stop with nothing running (or after the terminal state)
    is a clean 404. Frames caveat, accepted: the engine has no signal-time save
    (workhorse's KeyboardInterrupt handler just exits), so a stop keeps the last
    SAVED frame — up to ~steps_per_frame steps of work past it are lost."""

    LIVE = "s-8000-live"

    def setUp(self):
        super().setUp()
        self.started: list = []

        def fake_spawn_locked(values, fork_of, seed_locked, session_id=None, underpaint=None):
            self.started.append(session_id)
            self.manager.proc = FakeProc()
            self.manager.live_id = session_id
            self.manager.stop_requested = False  # mirrors the real _spawn_locked reset
            return session_id, 1234, FakeProc()

        self.manager._spawn_locked = fake_spawn_locked
        self.manager._announce_spawn = lambda sid, seed, proc: None

        # These tests route through the REAL MANAGER.stop, so killpg must be stubbed:
        # FakeProc's pid is no guarantee of an unused process group (Linux pid_max can
        # exceed any constant) — recording the calls also lets tests assert the SIGTERM.
        self.killpg_calls: list = []
        self._orig_killpg = os.killpg

        def fake_killpg(pgid, sig):
            self.killpg_calls.append((pgid, sig))
            raise ProcessLookupError(pgid)

        os.killpg = fake_killpg

    def tearDown(self):
        os.killpg = self._orig_killpg
        super().tearDown()

    def seed_live_session(self, frames=0):
        frames_dir = server.OUTPUTS_DIR / self.LIVE / "images_out" / self.LIVE
        frames_dir.mkdir(parents=True, exist_ok=True)
        for n in range(frames):
            (frames_dir / f"{self.LIVE}_{n + 1:04d}.png").write_bytes(b"png")
        server.STORE.put({
            "schemaVersion": 1, "id": self.LIVE, "slug": "live", "state": "rendering",
            "seed": 1, "startedAt": server.now_ms(), "stepsDone": 0, "stepsTotal": 100,
            "frames": frames, "forkedFrom": None, "artifacts": [],
            "config": {"scenes": "live prompt", "width": 256, "height": 256, "steps_per_scene": 100},
        })
        self.make_busy(self.LIVE)
        self.manager.started_at = time.time()

    def finalize_live(self):
        # The SIGTERMed render exits (negative exit code); the pump thread finalizes.
        self.manager._finalize(self.LIVE, -15, [])

    def test_stop_running_202_keeps_frames_and_advances_queue(self):
        self.seed_live_session(frames=3)
        queued = self.manager.enqueue(
            {"scenes": "next in line", "width": 256, "height": 256}, None, False)["queuedId"]
        status, resp = http("POST", f"/api/sessions/{self.LIVE}/stop")
        self.assertEqual(status, 202)
        self.assertEqual(resp, {"stopping": self.LIVE})
        self.assertTrue(self.manager.stop_requested)
        self.assertEqual(server.STORE.sessions[self.LIVE]["state"], "stopping")
        self.assertEqual(self.queue_ids(), [queued])  # stop itself never touches the queue
        self.finalize_live()
        s = server.STORE.sessions[self.LIVE]
        self.assertEqual(s["state"], "stopped")  # terminal — gallery shows its frames
        self.assertEqual(s["frames"], 3)  # KEEPS everything rendered so far
        self.assertIsNone(s.get("failExcerpt"))
        self.assertIsNotNone(s.get("endedAt"))
        # …and the FIFO advanced exactly like natural completion
        self.assertEqual(self.started, [queued])
        self.assertEqual(self.queue_ids(), [])
        self.assertIn((FakeProc.pid, signal.SIGTERM), self.killpg_calls)  # the group was signalled
        # the advanced render starts with a CLEAN flag — a stale True would finalize
        # every queue-advanced render after any stop as 'stopped' regardless of its
        # real exit code (the real reset is pinned by test_real_spawn_resets_stop_requested)
        self.assertFalse(self.manager.stop_requested)

    def test_stop_with_empty_queue_idles(self):
        self.seed_live_session(frames=1)
        status, _ = http("POST", f"/api/sessions/{self.LIVE}/stop")
        self.assertEqual(status, 202)
        self.finalize_live()
        self.assertEqual(server.STORE.sessions[self.LIVE]["state"], "stopped")
        self.assertIsNone(self.manager.proc)
        self.assertIsNone(self.manager.live_id)
        self.assertEqual(self.started, [])
        self.assertEqual(self.queue_ids(), [])

    def test_stop_then_detail_supports_tweak(self):
        # TWEAK/RE-RUN rematerialize from GET /api/sessions/{id}'s config snapshot —
        # a stopped session must serve it intact, exactly like a completed one.
        self.seed_live_session(frames=2)
        http("POST", f"/api/sessions/{self.LIVE}/stop")
        self.finalize_live()
        status, detail = http("GET", f"/api/sessions/{self.LIVE}")
        self.assertEqual(status, 200)
        self.assertEqual(detail["state"], "stopped")
        self.assertEqual(detail["frames"], 2)
        self.assertEqual(detail["config"],
                         {"scenes": "live prompt", "width": 256, "height": 256, "steps_per_scene": 100})

    def test_double_stop_is_idempotent_then_404_after_terminal(self):
        self.seed_live_session()
        s1, _ = http("POST", f"/api/sessions/{self.LIVE}/stop")
        s2, _ = http("POST", f"/api/sessions/{self.LIVE}/stop")
        self.assertEqual((s1, s2), (202, 202))  # impatient double-click: one death, no error
        self.finalize_live()
        self.assertEqual(server.STORE.sessions[self.LIVE]["state"], "stopped")
        s3, _ = http("POST", f"/api/sessions/{self.LIVE}/stop")
        self.assertEqual(s3, 404)  # nothing running under this id anymore — clean 4xx
        # …and the late stop never touched the settled record: a terminal state
        # must stay terminal (the stop/finalize race, other interleaving)
        self.assertEqual(server.STORE.sessions[self.LIVE]["state"], "stopped")

    def test_stopping_write_holds_the_manager_lock(self):
        # THE stop/finalize race (a stop landing at the instant the render exits
        # naturally): the 'stopping' record write must serialize against _finalize's
        # terminal write, i.e. happen while the manager lock is held — an unlocked
        # write can land AFTER 'stopped' and permanently revert the record to a
        # non-terminal state (phantom rendering tile until the next server restart).
        self.seed_live_session()
        locked_at_write = []
        orig_update = server.STORE.update

        def spy_update(sid, **fields):
            if fields.get("state") == "stopping":
                locked_at_write.append(self.manager._lock.locked())
            return orig_update(sid, **fields)

        server.STORE.update = spy_update
        try:
            status, _ = http("POST", f"/api/sessions/{self.LIVE}/stop")
        finally:
            del server.STORE.update  # instance attr; deleting restores the real method
        self.assertEqual(status, 202)
        self.assertEqual(locked_at_write, [True])

    def test_phase_announce_dropped_once_stopping(self):
        # tqdm/log lines already in the pipe when stop() lands (or emitted during the
        # SIGTERM grace) reach the pump's one-shot phase announce AFTER the 'stopping'
        # write; the flip must be dropped or the client's STOPPING chip reverts to a
        # live bar and the STOP control resurfaces mid-stop (spec §7.3).
        self.seed_live_session()
        http("POST", f"/api/sessions/{self.LIVE}/stop")
        self.manager._announce_phase(self.LIVE, "rendering")
        self.assertEqual(server.STORE.sessions[self.LIVE]["state"], "stopping")

    def test_real_spawn_resets_stop_requested(self):
        # The production reset lives in _spawn_locked (the fake above mirrors it):
        # pin the REAL one — a refactor dropping it would poison every queue-advanced
        # render after any stop (stop_requested stays True across _finalize ->
        # _start_next -> spawn, finalizing them all as 'stopped').
        self.manager.stop_requested = True
        orig_popen = server.subprocess.Popen
        orig_conf_dir = server.SESSIONS_CONF_DIR
        server.subprocess.Popen = lambda *a, **k: FakeProc()
        server.SESSIONS_CONF_DIR = Path(self._tmp.name) / "_sessions"
        try:
            with self.manager._lock:
                server.RenderManager._spawn_locked(
                    self.manager, {"scenes": "clean flag", "width": 256, "height": 256}, None, False)
        finally:
            server.subprocess.Popen = orig_popen
            server.SESSIONS_CONF_DIR = orig_conf_dir
        self.assertFalse(self.manager.stop_requested)

    def test_stop_nothing_running_404(self):
        status, _ = http("POST", "/api/sessions/s-0042-anything/stop")
        self.assertEqual(status, 404)
        self.assertIsNone(self.manager.proc)

    def test_stop_wrong_id_404_live_untouched(self):
        self.seed_live_session()
        status, _ = http("POST", "/api/sessions/s-0042-other/stop")
        self.assertEqual(status, 404)
        self.assertIsNotNone(self.manager.proc)
        self.assertFalse(self.manager.stop_requested)


class TestStreamSegments(unittest.TestCase):
    """The pump's stream splitter (task #9 root cause): tqdm redraws with bare
    '\\r' and only newlines when the bar closes, so a readline() pump received a
    whole render's progress as one end-of-run blob — stepsDone sat at 0 for the
    entire render. Segments must arrive per redraw."""

    def segments(self, raw: str) -> list:
        return list(server.RenderManager._stream_segments(io.StringIO(raw)))

    def test_cr_redraws_yield_one_segment_each(self):
        raw = " 0%| | 0/10 [00:00<?, ?it/s]\r10%|X| 1/10 [00:00<00:01, 6.7it/s]\r20%|XX| 2/10 [00:00<00:01, 7.1it/s]\n"
        self.assertEqual(
            [s.strip() for s in self.segments(raw)],
            [
                "0%| | 0/10 [00:00<?, ?it/s]",
                "10%|X| 1/10 [00:00<00:01, 6.7it/s]",
                "20%|XX| 2/10 [00:00<00:01, 7.1it/s]",
            ],
        )

    def test_plain_lines_unchanged_and_unterminated_tail_flushes(self):
        raw = "Running prompt: a check\npartial tail without newline"
        self.assertEqual(
            self.segments(raw),
            ["Running prompt: a check", "partial tail without newline"],
        )

    def test_crlf_and_empty_runs_yield_no_empty_segments(self):
        self.assertEqual(self.segments("a\r\nb\n\n\r\rc\n"), ["a", "b", "c"])

    def test_progress_matches_every_redraw_segment(self):
        # End-to-end through the regexes the pump uses: every redraw segment
        # after the scene gate must be a countable progress event.
        raw = "Running prompt: x\n 1/50 [00:00<00:20, 2.2it/s]\r 2/50 [00:00<00:20, 2.3it/s]\r 3/50 [00:01<00:19, 2.4it/s]\n"
        steps = []
        gated = False
        for seg in self.segments(raw):
            if server.SCENE_RE.search(seg):
                gated = True
                continue
            m = server.TQDM_RE.search(seg)
            if m and gated:
                steps.append(int(m.group(1)))
        self.assertEqual(steps, [1, 2, 3])


class TestUnderpaintEnvelope(SessionsPostBase):
    """§16: the 'underpaint' envelope field on the self-contained POST — parsing,
    defaults, refusals, the draft-path exclusion, and the §5.6 isolation regression
    (an underpaint submission never reads or writes the shared draft)."""

    def test_llamagen_defaults_100_steps(self):
        status, _ = http("POST", "/api/sessions",
                         {"mode": "now", "values": dict(VALID_VALUES), "underpaint": {"source": "llamagen"}})
        self.assertEqual(status, 201)
        self.assertEqual(self.calls[0][4], {"source": "llamagen", "steps": 100})

    def test_fourier_defaults_150_steps(self):
        status, _ = http("POST", "/api/sessions",
                         {"mode": "queue", "values": dict(VALID_VALUES), "underpaint": {"source": "fourier"}})
        self.assertEqual(status, 202)
        self.assertEqual(self.calls[0][0], "enqueue")
        self.assertEqual(self.calls[0][4], {"source": "fourier", "steps": 150})

    def test_explicit_steps_honored(self):
        status, _ = http("POST", "/api/sessions",
                         {"mode": "now", "values": dict(VALID_VALUES),
                          "underpaint": {"source": "fourier", "steps": 200}})
        self.assertEqual(status, 201)
        self.assertEqual(self.calls[0][4], {"source": "fourier", "steps": 200})

    def test_junk_envelope_400(self):
        for underpaint in (
            {"source": "vqgan"},                       # not a source
            {"source": "llamagen", "steps": 0},        # out of range
            {"source": "llamagen", "steps": 1},        # engine never saves a step-0 frame — no handoff possible
            {"source": "llamagen", "steps": "many"},   # mistyped
            {"source": "llamagen", "steps": True},     # bool is not an int
            {"source": "llamagen", "bogus": 1},        # unknown key
            {"steps": 100},                            # source missing
            "llamagen",                                # not an object
        ):
            status, resp = http("POST", "/api/sessions",
                                {"mode": "now", "values": dict(VALID_VALUES), "underpaint": underpaint})
            self.assertEqual(status, 400, underpaint)
            self.assertIn("underpaint", resp["error"])
        self.assertEqual(self.calls, [])

    def test_underpaint_on_the_draft_path_400(self):
        # The envelope field belongs to self-contained submissions only — the shared
        # draft must never grow hidden two-phase behavior (§16).
        self.seed_draft({"scenes": "bench draft prompt"})
        status, resp = http("POST", "/api/sessions", {"mode": "now", "underpaint": {"source": "fourier"}})
        self.assertEqual(status, 400)
        self.assertIn("self-contained", resp["error"])
        self.assertEqual(self.calls, [])

    def test_attachment_without_mask_400(self):
        init = Path(self._tmp.name) / "init.png"
        init.write_bytes(b"png")
        status, resp = http("POST", "/api/sessions", {
            "mode": "now",
            "values": {**VALID_VALUES, "init_image": str(init), "direct_init_weight": "4"},
            "underpaint": {"source": "llamagen"},
        })
        self.assertEqual(status, 400)
        self.assertIn("mask", resp["error"])
        self.assertEqual(self.calls, [])

    def test_attachment_with_missing_mask_file_400(self):
        init = Path(self._tmp.name) / "init.png"
        init.write_bytes(b"png")
        status, resp = http("POST", "/api/sessions", {
            "mode": "now",
            "values": {**VALID_VALUES, "init_image": str(init),
                       "direct_init_weight": f"4_[{self._tmp.name}/gone.png]"},
            "underpaint": {"source": "llamagen"},
        })
        self.assertEqual(status, 400)
        self.assertIn("not found", resp["error"])
        self.assertEqual(self.calls, [])

    def test_attachment_with_painted_mask_accepted(self):
        init = Path(self._tmp.name) / "init.png"
        mask = Path(self._tmp.name) / "mask.png"
        init.write_bytes(b"png")
        mask.write_bytes(b"png")
        status, _ = http("POST", "/api/sessions", {
            "mode": "now",
            "values": {**VALID_VALUES, "init_image": str(init),
                       "direct_init_weight": f"4_[-{mask}]"},
            "underpaint": {"source": "fourier"},
        })
        self.assertEqual(status, 201)
        self.assertEqual(self.calls[0][4], {"source": "fourier", "steps": 150})

    def test_underpaint_never_touches_the_draft(self):
        # §5.6 isolation regression, extended to §16: the two-phase path composes
        # from tuned defaults + body values; the shared draft is byte- and
        # mtime-identical afterwards.
        self.seed_draft({"scenes": "poisoned draft", "smoothing_weight": 99.0})
        before = self.draft_fingerprint()
        status, _ = http("POST", "/api/sessions",
                         {"mode": "now", "values": dict(VALID_VALUES), "underpaint": {"source": "llamagen"}})
        self.assertEqual(status, 201)
        self.assertEqual(self.draft_fingerprint(), before)
        values = self.calls[0][1]
        self.assertEqual(values["scenes"], VALID_VALUES["scenes"])
        self.assertEqual(values["smoothing_weight"], server.tuned_defaults()["smoothing_weight"])


class TestUnderpaintDerivation(unittest.TestCase):
    """§16 phase-1 derivation: same scenes/seed/dims/perceptors, source overrides,
    and EVERY field the underpaint pass must reset — enumerated, so a future schema
    field that latent models refuse gets added here or fails loud in live use."""

    BASE = {
        "scenes": "a stone temple || a glass temple",
        "seed": 42,
        "width": 448, "height": 576,
        "steps_per_scene": 300,
        "steps_per_frame": 20, "save_every": 0,  # the session cadence must NOT ride into phase 1
        "pixel_size": 4,  # LlamaGen multiplies dims by it — must reset to 1
        "image_model": "Limited Palette",
        "perceptor_backend": "mlx_full",
        "FARE4ViTB32": True,
        # the whole experiments/init surface, set to non-defaults on purpose:
        "init_image": "/abs/user.png",
        "direct_init_weight": "4_[/abs/mask.png]",
        "semantic_init_weight": "4",
        "init_spectrum": "pink", "init_spectrum_falloff": 2.0, "init_spectrum_chroma": "mono",
        "coarse_to_fine": True, "coarse_stages": 3,
        "structure_annealing": True, "anneal_cycles": 5, "anneal_strength": 0.9,
        "anneal_band": 0.3, "anneal_source": "blur",
        "manifold_projection": True, "projection_every": 10, "projection_strength": 1.0,
        "projection_model": "ds16",
        "auto_stop": True, "auto_stop_window": 10, "auto_stop_threshold": 0.1,
        "phase_scheduling": True, "breath_mode": True,
        "animation_mode": "2D", "interpolation_steps": 50,
        "fourier_parameterization": False, "fourier_decay": 1.0,
    }

    def test_llamagen_overrides_and_strips(self):
        phase1 = server.derive_underpaint_values(dict(self.BASE), {"source": "llamagen", "steps": 100})
        # source overrides
        self.assertEqual(phase1["image_model"], "LlamaGen")
        self.assertEqual(phase1["llamagen_model"], "ds8")
        self.assertEqual(phase1["perceptor_backend"], "torch")  # latent models are torch-only
        self.assertEqual(phase1["steps_per_scene"], 100)
        # save cadence pinned to the budget: the engine has NO end-of-run save, so
        # the session's cadence would save nothing (cadence > budget) or hand the
        # finish a stale canvas (non-divisor cadence)
        self.assertEqual(phase1["save_every"], 100)
        self.assertEqual(phase1["steps_per_frame"], 100)
        self.assertIs(phase1["fourier_parameterization"], False)
        # carried verbatim: scenes/seed/dims/perceptor flags
        self.assertEqual(phase1["scenes"], self.BASE["scenes"])
        self.assertEqual(phase1["seed"], 42)
        self.assertEqual((phase1["width"], phase1["height"]), (448, 576))
        self.assertIs(phase1["FARE4ViTB32"], True)
        # the strip list, enumerated (UNDERPAINT_NEUTRAL): every field a latent
        # model refuses, the init surface, and finish-only behaviors
        for field, neutral in server.UNDERPAINT_NEUTRAL.items():
            self.assertEqual(phase1[field], neutral, field)

    def test_fourier_overrides_and_backend_mapping(self):
        phase1 = server.derive_underpaint_values(dict(self.BASE), {"source": "fourier", "steps": 150})
        self.assertEqual(phase1["image_model"], "Unlimited Palette")
        self.assertIs(phase1["fourier_parameterization"], True)
        self.assertEqual(phase1["steps_per_scene"], 150)
        self.assertEqual(phase1["save_every"], 150)
        self.assertEqual(phase1["steps_per_frame"], 150)
        self.assertEqual(phase1["init_spectrum"], "white")  # the Fourier init IS 1/f-shaped
        self.assertEqual(phase1["perceptor_backend"], "mlx_full")  # session's, fourier-compatible
        for backend, expected in (("torch", "torch"), ("mlx_full", "mlx_full"), ("mlx", "mlx_full")):
            p = server.derive_underpaint_values({**self.BASE, "perceptor_backend": backend},
                                                {"source": "fourier", "steps": 150})
            self.assertEqual(p["perceptor_backend"], expected, backend)
        for field, neutral in server.UNDERPAINT_NEUTRAL.items():
            self.assertEqual(phase1[field], neutral, field)

    def test_parse_create_mask_subset(self):
        cases = [
            ("4_[/a/m.png]", ("/a/m.png", False)),
            ("4_[-/a/m.png]", ("/a/m.png", True)),
            ("1.5_[ -/a/m.jpg ]", ("/a/m.jpg", True)),
            ("2", None),                     # no mask token
            ("", None),
            ("4_[/a/m.mp4]", None),          # video mask — not the Create subset
            ("4_[/a/m.png]_0.5", None),      # cutoff field — opaque
            ("_[/a/m.png]", None),           # empty weight
        ]
        for raw, expected in cases:
            self.assertEqual(server.parse_create_mask(raw), expected, raw)


class FakePopen:
    """Popen stand-in recording the spawn command; wait() exits immediately."""
    def __init__(self, cmd, **kwargs):
        self.cmd = cmd
        self.pid = 424242
        self.stdout = io.StringIO("")
        self.returncode = 0

    def wait(self, timeout=None):
        return 0


class UnderpaintLifecycleBase(QueueBase):
    """Real _spawn_locked/_finalize/_start_finish against a stubbed Popen: the whole
    §16 lifecycle — spawn, handoff, stop-per-phase, failure, queue advance — without
    any real render."""

    def setUp(self):
        super().setUp()
        self.spawned_cmds: list[list] = []
        self._orig_popen = server.subprocess.Popen

        def fake_popen(cmd, **kwargs):
            proc = FakePopen(cmd, **kwargs)
            self.spawned_cmds.append(cmd)
            return proc

        server.subprocess.Popen = fake_popen
        self._conf_orig = server.SESSIONS_CONF_DIR
        server.SESSIONS_CONF_DIR = Path(self._tmp.name) / "_sessions"
        # _announce_spawn starts pump/watch threads against the fake proc — stub it
        # (the pattern every queue test uses); announcements are asserted via STORE.
        self.manager._announce_spawn = lambda sid, seed, proc: None

    def tearDown(self):
        server.subprocess.Popen = self._orig_popen
        server.SESSIONS_CONF_DIR = self._conf_orig
        super().tearDown()

    def spawn_two_phase(self, sid="s-7000-up", source="llamagen", steps=100, values=None):
        values = values or {"scenes": "temple in fog", "width": 256, "height": 256,
                            "steps_per_scene": 300, "image_model": "Limited Palette",
                            "perceptor_backend": "mlx_full", "seed": 7}
        with self.manager._lock:
            return self.manager._spawn_locked(values, None, True, session_id=sid,
                                              underpaint={"source": source, "steps": steps})

    def seed_underpaint_frames(self, sid, n=3):
        d = server.OUTPUTS_DIR / sid / "underpaint" / "images_out" / sid
        d.mkdir(parents=True, exist_ok=True)
        for i in range(n):
            (d / f"{sid}_{i + 1:04d}.png").write_bytes(b"png")
        return sorted(d.iterdir())

    def session_conf(self, sid) -> dict:
        import yaml
        return yaml.safe_load((server.SESSIONS_CONF_DIR / f"{sid}.yaml").read_text())

    def state_events_for(self, sid, since=0):
        return [json.loads(data) for _, event, data in list(server.HUB._ring)[since:]
                if event == "state" and json.loads(data).get("sessionId") == sid]


class TestUnderpaintLifecycle(UnderpaintLifecycleBase):
    def test_spawn_phase1_records_and_derived_conf(self):
        sid, seed, proc = self.spawn_two_phase()
        s = server.STORE.sessions[sid]
        self.assertEqual(s["underpaint"], {"source": "llamagen", "steps": 100, "done": False})
        self.assertEqual(s["stepsTotal"], 400)  # combined: 100 underpaint + 300 finish
        self.assertEqual(s["config"]["image_model"], "Limited Palette")  # sidecar = the USER submission
        self.assertEqual(self.manager.phase, "underpaint")
        self.assertIsNotNone(self.manager.live_finish)
        self.assertEqual(self.manager.steps_total, 400)
        # phase 1 runs the DERIVED conf in the underpaint subdir under the same id
        self.assertIn(f"conf=_sessions/{sid}-underpaint", self.spawned_cmds[0])
        self.assertIn(f"hydra.run.dir=outputs/{sid}/underpaint", self.spawned_cmds[0])
        self.assertIn(f"file_namespace={sid}", self.spawned_cmds[0])
        phase1 = self.session_conf(f"{sid}-underpaint")
        self.assertEqual(phase1["image_model"], "LlamaGen")
        self.assertEqual(phase1["llamagen_model"], "ds8")
        self.assertEqual(phase1["perceptor_backend"], "torch")
        self.assertEqual(phase1["steps_per_scene"], 100)
        self.assertEqual(phase1["seed"], 7)  # same seed both phases
        self.assertIs(phase1["coarse_to_fine"], False)
        # pump arithmetic follows the RUNNING config (phase-1 steps_per_scene)
        self.assertEqual(self.manager.live_values["steps_per_scene"], 100)

    def test_handoff_spawns_phase2_same_session_no_terminal(self):
        sid, _, _ = self.spawn_two_phase()
        frames = self.seed_underpaint_frames(sid)
        ring_before = len(server.HUB._ring)
        self.manager._finalize(sid, 0, [])
        # ONE session: same id, phase 2 live, nothing terminal published in between
        self.assertEqual(self.manager.live_id, sid)
        self.assertEqual(self.manager.phase, "main")
        self.assertIsNone(self.manager.live_finish)
        s = server.STORE.sessions[sid]
        self.assertEqual(s["state"], "launching")
        self.assertEqual(s["underpaint"], {"source": "llamagen", "steps": 100, "done": True})
        self.assertIsNone(s.get("endedAt"))
        for ev in self.state_events_for(sid, since=ring_before):
            self.assertNotIn(ev.get("state"), ("done", "failed", "stopped"))
        # the finish conf: user's actual config + the injections (§16 / the eval legs)
        finish = self.session_conf(sid)
        self.assertEqual(finish["init_image"], str(frames[-1]))
        self.assertEqual(finish["direct_init_weight"], server.UNDERPAINT_FINISH_WEIGHT)
        self.assertIs(finish["coarse_to_fine"], False)
        self.assertEqual(finish["image_model"], "Limited Palette")
        self.assertEqual(finish["steps_per_scene"], 300)
        self.assertIn(f"conf=_sessions/{sid}", self.spawned_cmds[1])
        self.assertIn(f"hydra.run.dir=outputs/{sid}", self.spawned_cmds[1])
        # progress continues where phase 1 ended: combined total, phase-1 offset
        self.assertEqual(self.manager.resume_offset, 100)
        self.assertEqual(self.manager.steps_total, 400)

    def test_handoff_forces_c2f_off_even_when_the_base_carries_it(self):
        # A tweak base with coarse_to_fine survives submit (the composer guard is
        # client-side); the server backstop must strip it — the pyramid's stage-1
        # downsample would destroy the underpaint.
        sid, _, _ = self.spawn_two_phase(values={
            "scenes": "temple", "width": 256, "height": 256, "steps_per_scene": 300,
            "image_model": "Limited Palette", "coarse_to_fine": True, "coarse_stages": 3, "seed": 7,
        })
        self.seed_underpaint_frames(sid)
        self.manager._finalize(sid, 0, [])
        finish = self.session_conf(sid)
        self.assertIs(finish["coarse_to_fine"], False)
        self.assertEqual(finish["coarse_stages"], 2)  # non-default stages + false is schema-rejected
        # the sidecar still records the user's intent verbatim
        self.assertIs(server.STORE.sessions[sid]["config"]["coarse_to_fine"], True)

    def test_stop_during_phase1_stops_the_session_and_advances(self):
        sid, _, _ = self.spawn_two_phase()
        self.seed_underpaint_frames(sid)  # frames exist; a stop must still NOT hand off
        queued = self.manager.enqueue({"scenes": "next", "width": 256, "height": 256}, None, False)["queuedId"]
        self.manager.stop_requested = True  # the stop endpoint's flag (its own tests cover the write)
        self.manager._finalize(sid, -15, [])
        s = server.STORE.sessions[sid]
        self.assertEqual(s["state"], "stopped")
        self.assertIs(s["underpaint"]["done"], False)
        # underpaint frames are KEPT on disk
        self.assertEqual(len(server.underpaint_frame_files(sid)), 3)
        # the queue advanced exactly like natural completion
        self.assertEqual(self.manager.live_id, queued)
        self.assertEqual(self.queue_ids(), [])

    def test_phase1_failure_fails_the_session_with_excerpt_and_advances(self):
        sid, _, _ = self.spawn_two_phase()
        queued = self.manager.enqueue({"scenes": "next", "width": 256, "height": 256}, None, False)["queuedId"]
        self.manager._finalize(sid, 1, ["RuntimeError: MPS out of memory"])
        s = server.STORE.sessions[sid]
        self.assertEqual(s["state"], "failed")
        self.assertIn("MPS out of memory", "\n".join(s["failExcerpt"]))
        self.assertIn("underpaint phase", "\n".join(s["failExcerpt"]))
        self.assertEqual(self.manager.live_id, queued)

    def test_handoff_with_no_frames_fails_loud_and_advances(self):
        sid, _, _ = self.spawn_two_phase()
        queued = self.manager.enqueue({"scenes": "next", "width": 256, "height": 256}, None, False)["queuedId"]
        self.manager._finalize(sid, 0, [])  # phase 1 "succeeded" but produced nothing
        s = server.STORE.sessions[sid]
        self.assertEqual(s["state"], "failed")
        self.assertIn("no frames", "\n".join(s["failExcerpt"]))
        self.assertEqual(self.manager.live_id, queued)

    def test_stop_during_phase2_is_the_normal_stop(self):
        sid, _, _ = self.spawn_two_phase()
        self.seed_underpaint_frames(sid)
        self.manager._finalize(sid, 0, [])  # handoff -> phase 2 live
        self.manager.stop_requested = True
        self.manager._finalize(sid, -15, [])
        s = server.STORE.sessions[sid]
        self.assertEqual(s["state"], "stopped")
        self.assertIs(s["underpaint"]["done"], True)

    def test_queued_two_phase_item_is_one_item_and_starts_two_phase(self):
        self.make_busy("s-8000-live")
        result = self.manager.enqueue({"scenes": "queued underpaint", "width": 256, "height": 256,
                                       "steps_per_scene": 200, "seed": 3},
                                      None, True, underpaint={"source": "fourier", "steps": 150})
        self.assertEqual(set(result), {"queuedId", "position"})  # ONE item
        self.assertEqual(len(self.manager.queue), 1)
        self.assertEqual(self.manager.queue[0]["underpaint"], {"source": "fourier", "steps": 150})
        # seed a finishable live record so the real _finalize can drain the queue
        (server.OUTPUTS_DIR / "s-8000-live").mkdir(parents=True, exist_ok=True)
        server.STORE.put({"schemaVersion": 1, "id": "s-8000-live", "slug": "live", "state": "rendering",
                          "seed": 1, "startedAt": server.now_ms(), "stepsDone": 0, "stepsTotal": 100,
                          "frames": 0, "forkedFrom": None, "artifacts": [], "config": {"scenes": "live"}})
        self.manager.started_at = time.time()
        self.manager._finalize("s-8000-live", 0, [])
        sid = result["queuedId"]
        self.assertEqual(self.manager.live_id, sid)
        self.assertEqual(self.manager.phase, "underpaint")
        s = server.STORE.sessions[sid]
        self.assertEqual(s["underpaint"], {"source": "fourier", "steps": 150, "done": False})
        self.assertEqual(s["stepsTotal"], 350)
        phase1 = self.session_conf(f"{sid}-underpaint")
        self.assertEqual(phase1["image_model"], "Unlimited Palette")
        self.assertIs(phase1["fourier_parameterization"], True)

    def test_underpainting_substate_announce_and_summary_collapse(self):
        sid, _, _ = self.spawn_two_phase()
        self.manager._announce_phase(sid, "rendering")
        s = server.STORE.sessions[sid]
        self.assertEqual(s["state"], "underpainting")  # the tile's 'underpainting…' label
        summary = server.STORE.summary(s)
        self.assertEqual(summary["state"], "rendering")  # SessionSummary stays the spec enum
        self.assertEqual(summary["underpaint"], {"source": "llamagen", "steps": 100, "done": False})
        events = self.state_events_for(sid)
        self.assertEqual(events[-1]["state"], "underpainting")
        # phase 2 announces plain 'rendering' again
        self.seed_underpaint_frames(sid)
        self.manager._finalize(sid, 0, [])
        self.manager._announce_phase(sid, "rendering")
        self.assertEqual(server.STORE.sessions[sid]["state"], "rendering")

    def test_preempt_kills_whichever_phase_runs(self):
        sid, _, _ = self.spawn_two_phase()
        stopped = []
        self.manager.stop = lambda target: stopped.append(target)
        result = self.manager.preempt({"scenes": "jump", "width": 256, "height": 256}, None, False)
        self.assertEqual(stopped, [sid])  # phase 1 was live; its proc gets the SIGTERM
        self.assertEqual(result["preempting"], sid)

    def test_resume_after_phase1_interrupt_restarts_phase1(self):
        sid, _, _ = self.spawn_two_phase()
        self.manager.stop_requested = True
        self.manager._finalize(sid, -15, [])
        self.assertEqual(server.STORE.sessions[sid]["state"], "stopped")
        self.manager.resume(sid)
        self.assertEqual(self.manager.phase, "underpaint")  # phase 1 RESTARTS (v1 semantics)
        self.assertEqual(self.manager.live_id, sid)
        self.assertIn(f"conf=_sessions/{sid}-underpaint", self.spawned_cmds[-1])
        s = server.STORE.sessions[sid]
        self.assertIs(s["underpaint"]["done"], False)
        self.assertEqual(s["config"]["seed"], 7)  # same seed — a restart, not a reroll

    def test_live_slot_held_through_handoff_delete_409s_and_spawns_are_busy(self):
        # §16: the session owns the live slot BETWEEN procs (live_id stays set,
        # proc None) — a DELETE landing mid-handoff must 409 (the old clear let it
        # rmtree the session out from under _start_finish), and a manual start
        # must see busy instead of racing the phase-2 spawn.
        sid, _, _ = self.spawn_two_phase()
        self.seed_underpaint_frames(sid)
        observed = []
        orig = self.manager._write_session_conf

        def hooked(name, values):
            del self.manager._write_session_conf  # one-shot
            status, _ = http("DELETE", f"/api/sessions/{sid}")
            observed.append((status, self.manager.live_id))
            with self.assertRaises(RuntimeError):
                with self.manager._lock:
                    self.manager._spawn_locked({"scenes": "interloper", "width": 256, "height": 256}, None, False)
            return orig(name, values)

        self.manager._write_session_conf = hooked
        self.manager._finalize(sid, 0, [])
        self.assertEqual(observed, [(409, sid)])
        self.assertEqual(self.manager.live_id, sid)  # phase 2 committed under the same id
        self.assertEqual(self.manager.phase, "main")
        self.assertIn(sid, server.STORE.sessions)  # the record survived the delete attempt

    def test_stop_during_handoff_stops_session_without_phase2(self):
        # Stop-anytime holds through the handoff window: the endpoint 202s (no 404
        # against a visibly-live session), _start_finish aborts, phase 2 never spawns.
        sid, _, _ = self.spawn_two_phase()
        self.seed_underpaint_frames(sid)
        responses = []
        orig = self.manager._write_session_conf

        def hooked(name, values):
            del self.manager._write_session_conf  # one-shot
            responses.append(http("POST", f"/api/sessions/{sid}/stop"))
            return orig(name, values)

        self.manager._write_session_conf = hooked
        self.manager._finalize(sid, 0, [])
        self.assertEqual(responses[0][0], 202)
        s = server.STORE.sessions[sid]
        self.assertEqual(s["state"], "stopped")
        self.assertIs(s["underpaint"]["done"], False)
        self.assertIsNone(self.manager.live_id)
        self.assertEqual(len(self.spawned_cmds), 1)  # phase 1 only — phase 2 never spawned

    def test_preempt_during_handoff_stops_session_and_starts_preemptor(self):
        # A preempt landing in the handoff window must NOT park behind the whole
        # finish render: stop() lands on the held live slot, the handoff aborts,
        # and _finalize's auto-start spawns the preemptor next.
        sid, _, _ = self.spawn_two_phase()
        self.seed_underpaint_frames(sid)
        result = {}
        orig = self.manager._write_session_conf

        def hooked(name, values):
            del self.manager._write_session_conf  # one-shot
            result.update(self.manager.preempt(
                {"scenes": "jump the line", "width": 256, "height": 256}, None, False))
            return orig(name, values)

        self.manager._write_session_conf = hooked
        self.manager._finalize(sid, 0, [])
        self.assertEqual(result["preempting"], sid)
        self.assertEqual(server.STORE.sessions[sid]["state"], "stopped")
        self.assertEqual(self.manager.live_id, result["queuedId"])  # the preemptor runs now
        self.assertEqual(self.queue_ids(), [])

    def test_queued_underpaint_with_vanished_mask_fails_at_drain(self):
        # §16: the drain-time preflight re-runs validate_underpaint_submission —
        # a painted mask deleted while the item waited must fail the item at
        # start, not at the handoff after burning the whole phase-1 budget.
        self.make_busy("s-8000-live")
        init = Path(self._tmp.name) / "init.png"
        mask = Path(self._tmp.name) / "mask.png"
        init.write_bytes(b"png")
        mask.write_bytes(b"png")
        queued = self.manager.enqueue(
            {"scenes": "queued masked underpaint", "width": 256, "height": 256,
             "init_image": str(init), "direct_init_weight": f"4_[{mask}]", "seed": 3},
            None, True, underpaint={"source": "llamagen", "steps": 100})["queuedId"]
        mask.unlink()  # the user cleans it up while the item waits
        (server.OUTPUTS_DIR / "s-8000-live").mkdir(parents=True, exist_ok=True)
        server.STORE.put({"schemaVersion": 1, "id": "s-8000-live", "slug": "live", "state": "rendering",
                          "seed": 1, "startedAt": server.now_ms(), "stepsDone": 0, "stepsTotal": 100,
                          "frames": 0, "forkedFrom": None, "artifacts": [], "config": {"scenes": "live"}})
        self.manager.started_at = time.time()
        self.manager._finalize("s-8000-live", 0, [])
        s = server.STORE.sessions[queued]
        self.assertEqual(s["state"], "failed")
        self.assertIn("mask not found", "\n".join(s["failExcerpt"]))
        self.assertIsNone(self.manager.live_id)  # phase 1 never spawned for it

    def test_underpaint_frame_files_is_the_canonical_series_sorted_numerically(self):
        # The handoff seeds phase 2 from frames[-1]: only '<sid>_<n>.png' counts,
        # by numeric index — a stray png, a composite, or a future engine
        # collision series ('<sid>(1)_…') must never sort ahead of the real
        # final frame ('(' < '_' lexicographically; '_0010' < '_2' too).
        sid = "s-7100-up"
        d = server.OUTPUTS_DIR / sid / "underpaint" / "images_out" / sid
        d.mkdir(parents=True, exist_ok=True)
        for name in (f"{sid}_2.png", f"{sid}_0010.png", f"{sid}(1)_0001.png",
                     f"{sid}(1)_0099.png", "composite.png", f"{sid}_x.png"):
            (d / name).write_bytes(b"png")
        frames = server.underpaint_frame_files(sid)
        self.assertEqual([p.name for p in frames], [f"{sid}_2.png", f"{sid}_0010.png"])

    def test_watcher_exits_when_a_newer_spawn_takes_over(self):
        # §16: the handoff spawns a second _watch_frames(sid) for phase 2 while
        # live_id never blips to None — the generation token makes the phase-1
        # watcher exit instead of double-publishing every phase-2 frame forever.
        import threading
        sid = "s-7200-watch"
        self.manager.proc = FakeProc()
        self.manager.live_id = sid
        t = threading.Thread(target=self.manager._watch_frames, args=(sid,), daemon=True)
        t.start()
        time.sleep(0.1)
        self.assertTrue(t.is_alive())  # its own generation: the watcher polls on
        with self.manager._lock:
            self.manager._watch_gen += 1  # a newer spawn (phase 2 / RESUME) commits
        t.join(timeout=3)
        self.assertFalse(t.is_alive())

    def test_resume_after_handoff_restores_phase2_with_offset(self):
        sid, _, _ = self.spawn_two_phase()
        self.seed_underpaint_frames(sid)
        self.manager._finalize(sid, 0, [])   # handoff
        self.manager.stop_requested = True
        self.manager._finalize(sid, -15, [])  # stopped mid-phase-2, zero main frames
        self.manager.resume(sid)
        self.assertEqual(self.manager.phase, "main")
        self.assertIn("restore=true", self.spawned_cmds[-1])
        self.assertIn(f"conf=_sessions/{sid}", self.spawned_cmds[-1])
        # the offset counts the whole phase-1 budget (its bars belonged to phase 1)
        self.assertEqual(self.manager.resume_offset, 100)


class TestUnderpaintComposite(unittest.TestCase):
    """§16 mask compositing: painted (white) = the user's content holds; inverted
    flips; everything fitted to the canvas like the engine fits an init image."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def png(self, name, color, size=(8, 8)):
        from PIL import Image
        p = self.dir / name
        Image.new("RGB", size, color).save(p)
        return p

    def mask_png(self, name, left_value, right_value, size=(8, 8)):
        from PIL import Image
        im = Image.new("L", size, right_value)
        for y in range(size[1]):
            for x in range(size[0] // 2):
                im.putpixel((x, y), left_value)
        p = self.dir / name
        im.save(p)
        return p

    def test_painted_region_holds_the_user_content(self):
        from PIL import Image
        under = self.png("under.png", (0, 0, 255))
        user = self.png("user.png", (255, 0, 0))
        mask = self.mask_png("mask.png", 255, 0)  # left painted white
        out = server.composite_underpaint(under, str(user), str(mask), False, 8, 8, self.dir / "out.png")
        im = Image.open(out).convert("RGB")
        self.assertEqual(im.size, (8, 8))
        self.assertEqual(im.getpixel((1, 4)), (255, 0, 0))  # painted -> user holds
        self.assertEqual(im.getpixel((6, 4)), (0, 0, 255))  # unpainted -> underpaint

    def test_inverted_mask_flips_the_regions(self):
        from PIL import Image
        under = self.png("under.png", (0, 0, 255))
        user = self.png("user.png", (255, 0, 0))
        mask = self.mask_png("mask.png", 255, 0)
        out = server.composite_underpaint(under, str(user), str(mask), True, 8, 8, self.dir / "out.png")
        im = Image.open(out).convert("RGB")
        self.assertEqual(im.getpixel((1, 4)), (0, 0, 255))
        self.assertEqual(im.getpixel((6, 4)), (255, 0, 0))

    def test_gray_mask_blends(self):
        from PIL import Image
        under = self.png("under.png", (0, 0, 0))
        user = self.png("user.png", (255, 255, 255))
        from PIL import Image as I
        mp = self.dir / "gray.png"
        I.new("L", (8, 8), 128).save(mp)
        out = server.composite_underpaint(under, str(user), str(mp), False, 8, 8, self.dir / "out.png")
        px = Image.open(out).convert("RGB").getpixel((4, 4))
        self.assertTrue(all(100 <= c <= 155 for c in px), px)  # ~50/50 blend

    def test_everything_fits_the_canvas_dims(self):
        from PIL import Image
        under = self.png("under.png", (0, 255, 0), size=(4, 4))
        user = self.png("user.png", (255, 0, 0), size=(32, 16))
        mask = self.mask_png("mask.png", 255, 255, size=(3, 5))
        out = server.composite_underpaint(under, str(user), str(mask), False, 16, 8, self.dir / "out.png")
        self.assertEqual(Image.open(out).size, (16, 8))  # canvas dims, like the engine (§15.1)


class TestUnderpaintRoute(unittest.TestCase):
    """GET /api/sessions/{id}/underpaint — the final phase-1 frame, path DERIVED from
    the session id alone (containment: no client path input), 404 until it exists."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._outputs_orig = server.OUTPUTS_DIR
        server.OUTPUTS_DIR = Path(self._tmp.name) / "outputs"
        server.OUTPUTS_DIR.mkdir()
        self.sid = "s-7100-route"
        server.STORE.sessions[self.sid] = {
            "schemaVersion": 1, "id": self.sid, "slug": "route", "state": "done",
            "seed": 1, "startedAt": server.now_ms(), "stepsDone": 0, "stepsTotal": 0,
            "frames": 0, "artifacts": [], "config": {},
            "underpaint": {"source": "llamagen", "steps": 100, "done": True},
        }

    def tearDown(self):
        server.STORE.sessions.pop(self.sid, None)
        server.OUTPUTS_DIR = self._outputs_orig
        self._tmp.cleanup()

    def test_404_without_frames_then_serves_the_final_frame(self):
        status, resp = http("GET", f"/api/sessions/{self.sid}/underpaint")
        self.assertEqual(status, 404)
        self.assertIn("underpaint", resp["error"])
        d = server.OUTPUTS_DIR / self.sid / "underpaint" / "images_out" / self.sid
        d.mkdir(parents=True)
        (d / f"{self.sid}_0001.png").write_bytes(b"first")
        (d / f"{self.sid}_0002.png").write_bytes(b"final")
        sock = FakeSocket(f"GET /api/sessions/{self.sid}/underpaint HTTP/1.1\r\nHost: t\r\n\r\n".encode())
        server.Handler(sock, ("127.0.0.1", 0), DummyServer())
        response = sock.out.getvalue()
        self.assertIn(b"200", response.split(b"\r\n", 1)[0])
        self.assertTrue(response.endswith(b"final"))  # the FINAL frame, not the first

    def test_unknown_session_404(self):
        status, _ = http("GET", "/api/sessions/s-0000-nope/underpaint")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
