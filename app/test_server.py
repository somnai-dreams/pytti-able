"""
Server tests for the two POST /api/sessions submission paths (stdlib unittest,
in-process: requests run through the real Handler over a fake socket, no port
is ever bound — never touches a live STUDIO).

The isolation invariant under test (docs/studio-create-spec.md §5.6):
a self-contained submission ({values, forkOf?, seedLocked?}) composes
config/default.yaml over schema defaults + the caller's values and NEVER
reads or writes the shared draft; a body without "values" keeps the
draft-based behavior byte-identical (the bench's path).

Run: .venv/bin/python app/test_server.py
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
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

        def fake_start(values, fork_of, seed_locked, session_id=None):
            self.calls.append(("start", values, fork_of, seed_locked))
            return "s-9999-test", 1234

        def fake_enqueue(values, fork_of, seed_locked):
            self.calls.append(("enqueue", values, fork_of, seed_locked))
            return {"queued": "s-9999-test", "replaced": False}

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
        kind, values, fork_of, seed_locked = self.calls[0]
        self.assertEqual(kind, "start")
        self.assertEqual(values["seed"], 42)
        self.assertEqual(fork_of, "s-0007-parent")
        self.assertIs(seed_locked, True)

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
        self.assertEqual(resp, {"queued": "s-9999-test", "replaced": False})
        self.assertEqual(self.calls[0][0], "enqueue")


class TestDraftBasedPathRegression(SessionsPostBase):
    """The bench's path: any POST body without "values" behaves exactly as before."""

    def test_bodyless_post_reads_the_draft(self):
        self.seed_draft({"scenes": "bench draft prompt", "steps_per_scene": 321},
                        fork_of="s-0002-base", seed_locked=True)
        status, resp = http("POST", "/api/sessions")  # no body at all
        self.assertEqual(status, 201)
        self.assertEqual(resp, {"sessionId": "s-9999-test", "seed": 1234})
        kind, values, fork_of, seed_locked = self.calls[0]
        self.assertEqual(kind, "start")
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
        kind, values, _, _ = self.calls[0]
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
