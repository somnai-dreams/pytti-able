"""
PYTTI STUDIO server.

Python-stdlib HTTP server (plus yaml/PIL/pytti, which the render venv already
has) that owns: the draft config, session lifecycle (spawn/stop/queue/resume
of pytti.workhorse subprocesses), the session library on disk, live telemetry
over SSE, thumbnails, encode jobs, and the schema service the frontend builds
itself from.

Everything the browser knows arrives through /api/*; there is no polling —
GET /api/events streams state/progress/frame/log/queue/encode events.

Layout on disk (all relative to app/):
  static/                      the frontend
  config/draft.yaml            the working draft (server-persisted)
  config/conf/*.yaml           presets (user bookmarks)
  config/conf/_sessions/*.yaml immutable per-session config snapshots
  outputs/<session-id>/        one dir per session (hydra run dir):
      session.json             sidecar: identity, state, telemetry
      images_out/<id>/*.png    frames
      thumbs/*.jpg             lazy thumbnails
      *.mp4|*.mov              encode artifacts
  measurements.json            s/step calibration buckets
  studio.yaml                  system settings (first boot)
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import random
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
from collections import deque
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import yaml

APP_DIR = Path(__file__).parent
STATIC_DIR = APP_DIR / "static"
CONFIG_DIR = APP_DIR / "config"
CONF_DIR = CONFIG_DIR / "conf"
SESSIONS_CONF_DIR = CONF_DIR / "_sessions"
OUTPUTS_DIR = APP_DIR / "outputs"
UPLOADS_DIR = APP_DIR / "uploads"
DRAFT_PATH = CONFIG_DIR / "draft.yaml"
MEASUREMENTS_PATH = APP_DIR / "measurements.json"
STUDIO_PATH = APP_DIR / "studio.yaml"
ANNOTATIONS_PATH = APP_DIR / "annotations.yaml"

PORT = int(os.environ.get("PYTTI_STUDIO_PORT", "7860"))

# fields the server owns; never taken from the draft when minting a session
MANAGED_FIELDS = ("file_namespace", "allow_overwrite", "restore", "config_version")

# ── ported from the retired gradio ui.py ────────────────────────────────────
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")
LOG_NOISE = re.compile(r"\| DEBUG\s+\||UserWarning:|warnings\.warn\(")
TQDM_RE = re.compile(r"(\d+)/(\d+)\s+\[.*?,\s*([\d.]+)(s/it|it/s)")
SCENE_RE = re.compile(r"Running prompt:", re.IGNORECASE)

ENCODE_FORMATS = {
    "mp4": {
        "ext": ".mp4",
        "args": ["-c:v", "libx264", "-crf", "17", "-preset", "slow", "-pix_fmt", "yuv420p"],
    },
    "prores4444": {
        "ext": ".mov",
        "args": ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"],
    },
    "proreshq": {
        "ext": ".mov",
        "args": ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"],
    },
}


def clean_prompt_field(text: str, leading_pipe=False, trailing_pipe=False) -> str:
    """Collapse whitespace and ensure proper | delimiters (ui.py forgiveness)."""
    cleaned = " ".join(str(text).split())
    if not cleaned:
        return ""
    if trailing_pipe and not cleaned.endswith("|"):
        cleaned += " |"
    if leading_pipe and not cleaned.startswith("|"):
        cleaned = "| " + cleaned
    return cleaned


def slugify(scenes: str) -> str:
    first = re.split(r"[|]", str(scenes))[0]
    words = re.findall(r"[a-zA-Z0-9]+", first.split(":")[0].lower())[:3]
    return "-".join(words) or "untitled"


def scene_count(scenes: str) -> int:
    return max(1, len([s for s in str(scenes).split("||") if s.strip()]))


def atomic_write(path: Path, text: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.rename(path)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data):
    atomic_write(path, json.dumps(data, indent=1))


def now_ms() -> int:
    return int(time.time() * 1000)


# ─────────────────────────────────────────────────────────────────────────────
# SSE hub
# ─────────────────────────────────────────────────────────────────────────────


class EventHub:
    def __init__(self):
        self._lock = threading.Lock()
        self._clients: list = []  # list of queue-like deques with events
        self._ring: deque = deque(maxlen=1000)
        self._next_id = 1

    def publish(self, event: str, data: dict):
        with self._lock:
            entry = (self._next_id, event, json.dumps(data))
            self._next_id += 1
            self._ring.append(entry)
            for q in self._clients:
                q.append(entry)

    def subscribe(self, last_event_id: int):
        q = deque()
        with self._lock:
            for entry in self._ring:
                if entry[0] > last_event_id:
                    q.append(entry)
            self._clients.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            # identity, not equality: deques compare by contents and every
            # drained client queue is an (equal) empty deque
            self._clients = [c for c in self._clients if c is not q]


HUB = EventHub()


# ─────────────────────────────────────────────────────────────────────────────
# Schema service — attrs introspection + annotations.yaml
# ─────────────────────────────────────────────────────────────────────────────

_SCHEMA_CACHE = None


def build_schema() -> dict:
    global _SCHEMA_CACHE
    if _SCHEMA_CACHE is not None:
        return _SCHEMA_CACHE
    import attrs

    from pytti.config.model_names import VQGAN_MODEL_NAMES
    from pytti.config.structured_config import CONFIG_VERSION, ConfigSchema

    annotations = yaml.safe_load(ANNOTATIONS_PATH.read_text(encoding="utf-8"))
    fields = {}
    for f in attrs.fields(ConfigSchema):
        if f.name == "config_version":
            continue
        meta = annotations.get(f.name)
        if meta is None:
            raise RuntimeError(f"annotations.yaml is missing field {f.name!r}")
        default = f.default
        if isinstance(default, attrs.Factory):  # pragma: no cover - none today
            default = default.factory()
        if default is attrs.NOTHING or repr(default) == "'???'" or default == "???":
            default = ""
        choices = None
        if f.validator is not None and getattr(f.validator, "__closure__", None):
            for cell in f.validator.__closure__:
                if isinstance(cell.cell_contents, list):
                    choices = list(cell.cell_contents)
        entry = dict(meta)
        entry["default"] = default
        if choices:
            entry["choices"] = choices
        fields[f.name] = entry
    _SCHEMA_CACHE = {
        "fields": fields,
        "vqganModels": list(VQGAN_MODEL_NAMES),
        "configVersion": CONFIG_VERSION,
    }
    return _SCHEMA_CACHE


def schema_defaults() -> dict:
    return {name: meta["default"] for name, meta in build_schema()["fields"].items()}


def coerce_values(values: dict) -> dict:
    """
    Parse-and-validate a draft against the schema's python types at the
    boundary, so strings never reach spawn/pump arithmetic. Raises ValueError
    naming the field.
    """
    import attrs

    from pytti.config.structured_config import ConfigSchema

    def type_name(tp):
        # attrs stores real type objects for plain annotations and
        # types.UnionType strings for X | None
        return tp.__name__ if isinstance(tp, type) else str(tp)

    types = {f.name: type_name(f.type) for f in attrs.fields(ConfigSchema)}
    out = {}
    for name, value in values.items():
        ftype = types.get(name)
        if ftype is None:
            raise ValueError(f"unknown config field {name!r}")
        optional = "None" in ftype
        base = ftype.replace(" | None", "").replace("Optional[", "").rstrip("]")
        try:
            if value is None or value == "":
                if optional:
                    out[name] = None
                elif base == "str":
                    # a cleared text field arrives as null/""; the schema's
                    # contract for plain-str fields (weight expressions etc.)
                    # is "" = disabled. None must NOT reach the session yaml:
                    # hydra rejects it at render time, far from the cause.
                    out[name] = ""
                else:
                    raise ValueError("empty value for a required field")
            elif base == "int":
                if isinstance(value, bool):
                    raise ValueError("bool is not an int")
                f = float(value)
                if f != int(f):
                    raise ValueError("not an integer")
                out[name] = int(f)
            elif base == "float":
                out[name] = float(value)
            elif base == "bool":
                if isinstance(value, bool):
                    out[name] = value
                elif str(value).lower() in ("true", "1"):
                    out[name] = True
                elif str(value).lower() in ("false", "0"):
                    out[name] = False
                else:
                    raise ValueError("not a bool")
            elif base == "str":
                out[name] = str(value)
            else:  # lists (audio filters) pass through; preflight checks them
                out[name] = value
        except (TypeError, ValueError) as e:
            raise ValueError(f"{name}: {value!r} is not a valid {base} ({e})") from e
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Calibration
# ─────────────────────────────────────────────────────────────────────────────


class Calibration:
    def __init__(self):
        self._lock = threading.Lock()
        self.buckets = {}
        if MEASUREMENTS_PATH.exists():
            self.buckets = read_json(MEASUREMENTS_PATH)

    @staticmethod
    def bucket_key(values: dict) -> str:
        clip_flags = [k for k in (
            "ViTB32", "ViTB16", "ViTL14", "ViTL14_336px",
            "RN50", "RN101", "RN50x4", "RN50x16", "RN50x64",
        ) if values.get(k)]
        return f"{values.get('width')}x{values.get('height')}/{len(clip_flags)}clip/{values.get('image_model')}"

    def record(self, values: dict, s_per_step: float, session_id: str):
        if not s_per_step or not math.isfinite(s_per_step):
            return
        key = self.bucket_key(values)
        with self._lock:
            b = self.buckets.get(key, {"sPerStep": s_per_step, "samples": 0})
            # EWMA, biased toward recent measurements
            b["sPerStep"] = 0.6 * s_per_step + 0.4 * b["sPerStep"]
            b["samples"] = b.get("samples", 0) + 1
            b["lastSession"] = session_id
            self.buckets[key] = b
            write_json(MEASUREMENTS_PATH, self.buckets)

    def estimate_s_per_step(self, values: dict):
        """Returns (sPerStep, basis, basisSession, samples)."""
        key = self.bucket_key(values)
        with self._lock:
            b = self.buckets.get(key)
            if b:
                return b["sPerStep"], "measured", b.get("lastSession"), b.get("samples", 0)
            # seeded guess: ~2s/step at 512^2 with 2 CLIP models, linear-ish scaling
            n_clip = int(key.split("/")[1].replace("clip", "") or 1)
            pixels = max(1, int(values.get("width", 512)) * int(values.get("height", 512)))
            guess = 2.0 * (pixels / (512 * 512)) * max(1, n_clip) / 2
            return max(0.3, guess), "seeded", None, 0


CALIBRATION = Calibration()


# ─────────────────────────────────────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────────────────────────────────────


def preflight(values: dict) -> dict:
    from pytti.prompt_spec import parse_prompt_spec

    schema = build_schema()["fields"]
    issues = []

    def issue(field, severity, message):
        section = schema.get(field, {}).get("section") or "engine"
        issues.append({"field": field, "section": section, "severity": severity, "message": message})

    scenes = str(values.get("scenes", ""))
    prefix = clean_prompt_field(values.get("scene_prefix", ""), trailing_pipe=True)
    suffix = clean_prompt_field(values.get("scene_suffix", ""), leading_pipe=True)
    if not scenes.strip():
        issue("scenes", "error", "Scenes is empty — the render needs at least one prompt.")
    else:
        for stage in scenes.split("||"):
            if not stage.strip():
                issue("scenes", "error", "Empty scene between '||' separators.")
                continue
            for p in (prefix + stage + suffix).strip().split("|"):
                if not p.strip():
                    continue
                try:
                    parse_prompt_spec(p.strip())
                except ValueError as e:
                    issue("scenes", "error", str(e))

    for name, meta in schema.items():
        if meta.get("choices") and name in values and values[name] not in meta["choices"]:
            issue(name, "error", f"{values[name]!r} is not one of {meta['choices']}")

    cutouts = int(values.get("cutouts", 40) or 0)
    gas = int(values.get("gradient_accumulation_steps", 1) or 1)
    if gas > 1 and cutouts % gas != 0:
        issue("gradient_accumulation_steps", "error",
              f"gradient_accumulation_steps ({gas}) must divide cutouts ({cutouts}).")

    if values.get("breath_mode") and not str(values.get("init_image", "")).strip():
        issue("breath_mode", "error", "Breath mode needs an init image to breathe from.")

    if values.get("image_model") == "VQGAN" and int(values.get("pixel_size", 1) or 1) != 1:
        issue("pixel_size", "warn", "VQGAN runs with pixel_size 1; larger values waste VRAM.")

    for path_field in ("init_image", "video_path", "target_palette", "input_audio"):
        p = str(values.get(path_field, "") or "").strip()
        if p and not p.startswith(("http://", "https://")) and not Path(p).expanduser().exists():
            issue(path_field, "error", f"File not found: {p}")

    if values.get("animation_mode") == "Video Source" and not str(values.get("video_path", "")).strip():
        issue("video_path", "error", "Video Source mode needs a video_path.")

    if int(values.get("interpolation_steps", 0) or 0) > int(values.get("steps_per_scene", 0) or 0):
        issue("interpolation_steps", "error",
              "interpolation_steps cannot exceed steps_per_scene — the crossfade "
              "would be longer than the scene itself.")

    n_scenes = scene_count(scenes)
    steps_per_scene = int(values.get("steps_per_scene", 100) or 0)
    steps_per_frame = int(values.get("steps_per_frame", 50) or 1)
    save_every = int(values.get("save_every", 0) or 0) or steps_per_frame
    steps_total = n_scenes * steps_per_scene
    frames = steps_total // max(1, save_every)
    fps = int(values.get("frames_per_second", 12) or 12)
    s_per_step, basis, basis_session, samples = CALIBRATION.estimate_s_per_step(values)

    return {
        "ok": not any(i["severity"] == "error" for i in issues),
        "issues": issues,
        "estimate": {
            "stepsTotal": steps_total,
            "frames": frames,
            "videoSec": round(frames / max(1, fps), 1),
            "wallClockSec": int(steps_total * s_per_step),
            "sPerStep": round(s_per_step, 2),
            "basis": basis,
            "basisSession": basis_session,
            "calibSamples": samples,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Session store
# ─────────────────────────────────────────────────────────────────────────────


class SessionStore:
    def __init__(self):
        self._lock = threading.Lock()
        self.sessions: dict[str, dict] = {}  # id -> sidecar dict (session.json shape)
        self.scan()

    # sidecar shape: { schemaVersion, id, slug, state, seed, startedAt, endedAt?,
    #   stepsDone, stepsTotal, frames, sPerStepAvg?, elapsedSec?, forkedFrom?,
    #   deltaSummary?, artifacts: [...], config: {...}, pid?, exitCode?, failExcerpt? }

    def scan(self):
        with self._lock:
            self.sessions = {}
            if not OUTPUTS_DIR.exists():
                return
            for d in OUTPUTS_DIR.iterdir():
                if not d.is_dir():
                    continue
                sidecar = d / "session.json"
                if sidecar.exists():
                    try:
                        s = read_json(sidecar)
                    except (json.JSONDecodeError, OSError) as e:
                        print(f"[store] unreadable sidecar {sidecar}: {e}", file=sys.stderr)
                        continue
                    s["frames"] = self._count_frames(d, s["id"])
                    s["artifacts"] = self._scan_artifacts(d)
                    self.sessions[s["id"]] = s
                elif re.match(r"\d{4}-\d{2}-\d{2}", d.name):
                    self._adopt_legacy(d)

    def _adopt_legacy(self, day_dir: Path):
        for time_dir in day_dir.iterdir():
            if not time_dir.is_dir():
                continue
            images_out = time_dir / "images_out"
            if not images_out.exists():
                continue
            for ns_dir in images_out.iterdir():
                frames = sorted(ns_dir.glob("*.png"))
                if not frames:
                    continue
                sid = f"imported-{day_dir.name}-{time_dir.name}-{ns_dir.name}"
                config = {}
                hydra_cfg = time_dir / ".hydra" / "config.yaml"
                if hydra_cfg.exists():
                    config = yaml.safe_load(hydra_cfg.read_text(encoding="utf-8")) or {}
                self.sessions[sid] = {
                    "schemaVersion": 1,
                    "id": sid,
                    "slug": ns_dir.name,
                    "state": "imported",
                    "seed": config.get("seed"),
                    "startedAt": int(time_dir.stat().st_mtime * 1000),
                    "stepsDone": 0,
                    "stepsTotal": 0,
                    "frames": len(frames),
                    "config": config,
                    "artifacts": self._scan_artifacts(time_dir),
                    "imported": True,
                    "runDir": str(time_dir),
                    "framesDir": str(ns_dir),
                }

    @staticmethod
    def _count_frames(run_dir: Path, session_id: str) -> int:
        frames_dir = run_dir / "images_out" / session_id
        if not frames_dir.exists():
            return 0
        return sum(1 for p in frames_dir.iterdir() if p.suffix == ".png")

    @staticmethod
    def _scan_artifacts(run_dir: Path) -> list:
        arts = []
        for p in run_dir.iterdir():
            if p.suffix in (".mp4", ".mov"):
                m = re.search(r"_(\d+)fps", p.name)
                arts.append({
                    "name": p.name,
                    "bytes": p.stat().st_size,
                    "fps": int(m.group(1)) if m else None,
                    "format": "mp4" if p.suffix == ".mp4" else "prores",
                })
        return sorted(arts, key=lambda a: a["name"])

    def mint_id(self, scenes: str, taken=()) -> str:
        with self._lock:
            numbers = [0]
            for sid in list(self.sessions) + list(taken):
                m = re.match(r"s-(\d+)-", sid)
                if m:
                    numbers.append(int(m.group(1)))
            return f"s-{max(numbers) + 1:04d}-{slugify(scenes)}"

    def run_dir(self, session_id: str) -> Path:
        s = self.sessions.get(session_id, {})
        if s.get("imported"):
            return Path(s["runDir"])
        return OUTPUTS_DIR / session_id

    def frames_dir(self, session_id: str) -> Path:
        s = self.sessions.get(session_id, {})
        if s.get("imported"):
            return Path(s["framesDir"])
        return OUTPUTS_DIR / session_id / "images_out" / session_id

    def frame_files(self, session_id: str) -> list[Path]:
        d = self.frames_dir(session_id)
        if not d.exists():
            return []
        return sorted(p for p in d.iterdir() if p.suffix == ".png")

    def put(self, session: dict):
        with self._lock:
            self.sessions[session["id"]] = session
            if not session.get("imported"):
                write_json(OUTPUTS_DIR / session["id"] / "session.json", session)

    def update(self, session_id: str, **patch):
        with self._lock:
            s = self.sessions[session_id]
            s.update(patch)
            if not s.get("imported"):
                write_json(OUTPUTS_DIR / session_id / "session.json", s)
            return s

    def summary(self, s: dict) -> dict:
        out = {
            k: s.get(k)
            for k in (
                "id", "slug", "state", "seed", "startedAt", "endedAt", "frames",
                "stepsDone", "stepsTotal", "sPerStepAvg", "elapsedSec", "forkedFrom",
                "deltaSummary", "artifacts", "imported", "exitCode", "failExcerpt",
            )
        }
        # SessionSummary.state is the spec enum; launch/load/stop substates
        # travel only on SSE state events
        if out["state"] in ("launching", "loading_models", "stopping"):
            out["state"] = "rendering"
        # Create-mode gallery needs prompt text + frame aspect before any thumb
        # loads (masonry heights come from data, not image measurement). All
        # three are null for sessions without a config snapshot (legacy imports).
        cfg = s.get("config") or {}
        out["scenes"] = cfg.get("scenes")
        out["width"] = cfg.get("width")
        out["height"] = cfg.get("height")
        return out

    def summaries(self) -> list[dict]:
        with self._lock:
            out = [self.summary(s) for s in self.sessions.values()]
        return sorted(out, key=lambda s: s.get("startedAt") or 0, reverse=True)

    def delta_summary(self, config: dict, parent_id: str | None) -> str | None:
        if not parent_id or parent_id not in self.sessions:
            return None
        parent = self.sessions[parent_id].get("config", {})
        changed = [
            k for k in set(config) | set(parent)
            if k not in MANAGED_FIELDS and config.get(k) != parent.get(k)
        ]
        if changed == ["seed"]:
            return "Δ seed only"
        if not changed:
            return "Δ nothing"
        shown = ", ".join(sorted(changed)[:3])
        more = f" +{len(changed) - 3}" if len(changed) > 3 else ""
        return f"Δ {shown}{more}"

    def delete(self, session_id: str):
        with self._lock:
            s = self.sessions.pop(session_id, None)
        if s and not s.get("imported"):
            shutil.rmtree(OUTPUTS_DIR / session_id, ignore_errors=True)
        # session config snapshot stays in _sessions/ as provenance; harmless


STORE = SessionStore()


# ─────────────────────────────────────────────────────────────────────────────
# Render manager
# ─────────────────────────────────────────────────────────────────────────────


class RenderManager:
    def __init__(self):
        self._lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.live_id: str | None = None
        self.live_values: dict | None = None
        self.queued: dict | None = None  # {id, slug, values, forkOf}
        self.stop_requested = False
        # live telemetry
        self.step = 0
        self.steps_total = 0
        self.scene = 0
        self.s_per_step_ewma = 0.0
        self.samples = 0
        self.started_at = 0.0
        self.resume_offset = 0  # steps completed before a resumed run's bars start

    # ── spawn ──────────────────────────────────────────────────────────────

    def start(self, values: dict, fork_of: str | None, seed_locked: bool, session_id: str | None = None):
        with self._lock:
            if self.proc is not None:
                raise RuntimeError("busy")
            taken = [self.queued["id"]] if self.queued else []
            sid = session_id or STORE.mint_id(values.get("scenes", ""), taken=taken)
            values = dict(values)
            if not seed_locked or values.get("seed") in (None, ""):
                values["seed"] = random.randint(0, 2**32 - 1)
            values["seed"] = int(values["seed"])
            values["scene_prefix"] = clean_prompt_field(values.get("scene_prefix", ""), trailing_pipe=True)
            values["scene_suffix"] = clean_prompt_field(values.get("scene_suffix", ""), leading_pipe=True)

            # NB: session YAML must be serialized with yaml.dump, never string
            # templates — YAML 1.1 parses an unquoted `off` as boolean False
            # (animation_mode!); yaml.dump quotes it correctly.
            snapshot = {k: v for k, v in values.items() if k not in MANAGED_FIELDS}
            SESSIONS_CONF_DIR.mkdir(parents=True, exist_ok=True)
            conf_path = SESSIONS_CONF_DIR / f"{sid}.yaml"
            atomic_write(conf_path, "# @package _global_\n" + yaml.dump(snapshot, default_flow_style=False, allow_unicode=True))

            run_dir = OUTPUTS_DIR / sid
            run_dir.mkdir(parents=True, exist_ok=True)

            n_scenes = scene_count(values.get("scenes", ""))
            steps_total = n_scenes * int(values.get("steps_per_scene", 100) or 0)

            env = {**os.environ, "PYTHONUNBUFFERED": "1"}
            cmd = [
                sys.executable, "-W", "ignore", "-m", "pytti.workhorse",
                f"conf=_sessions/{sid}",
                f"hydra.run.dir=outputs/{sid}",
                f"file_namespace={sid}",
            ]
            proc = subprocess.Popen(
                cmd, cwd=str(APP_DIR), env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                start_new_session=True,  # own process group: kill takes grandchildren (ffmpeg) too
            )
            (run_dir / "pid").write_text(str(proc.pid))

            session = {
                "schemaVersion": 1,
                "id": sid,
                "slug": slugify(values.get("scenes", "")),
                "state": "launching",
                "seed": values["seed"],
                "startedAt": now_ms(),
                "stepsDone": 0,
                "stepsTotal": steps_total,
                "frames": 0,
                "forkedFrom": fork_of,
                "deltaSummary": STORE.delta_summary(snapshot, fork_of),
                "artifacts": [],
                "config": snapshot,
            }
            STORE.put(session)

            self.proc = proc
            self.live_id = sid
            self.live_values = values
            self.stop_requested = False
            self.step = 0
            self.steps_total = steps_total
            self.scene = 0
            self.s_per_step_ewma = 0.0
            self.samples = 0
            self.started_at = time.time()
            self.resume_offset = 0

        HUB.publish("state", {"sessionId": sid, "state": "launching", "seed": values["seed"]})
        threading.Thread(target=self._pump_stdout, args=(proc, sid), daemon=True).start()
        threading.Thread(target=self._watch_frames, args=(sid,), daemon=True).start()
        return sid, values["seed"]

    def resume(self, session_id: str):
        s = STORE.sessions.get(session_id)
        if s is None or s.get("imported"):
            raise KeyError(session_id)
        values = dict(s["config"])
        values["restore"] = True
        # reuse the existing snapshot + dir; append restore as an override
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        cmd = [
            sys.executable, "-W", "ignore", "-m", "pytti.workhorse",
            f"conf=_sessions/{session_id}",
            f"hydra.run.dir=outputs/{session_id}",
            f"file_namespace={session_id}",
            "restore=true",
        ]
        with self._lock:
            # busy-check and spawn under the same lock (double-clicked RESUME
            # on a threading server must not spawn twice)
            if self.proc is not None:
                raise RuntimeError("busy")
            proc = subprocess.Popen(
                cmd, cwd=str(APP_DIR), env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                start_new_session=True,  # own process group: kill takes grandchildren (ffmpeg) too
            )
            (OUTPUTS_DIR / session_id / "pid").write_text(str(proc.pid))
            self.proc = proc
            self.live_id = session_id
            self.live_values = values
            self.stop_requested = False
            self.step = 0
            self.steps_total = s.get("stepsTotal", 0)
            self.scene = 0
            self.s_per_step_ewma = 0.0
            self.samples = 0
            self.started_at = time.time()
            # a resumed run's tqdm bars restart at 0; frames already on disk
            # tell us how many steps the previous run(s) completed
            save_every = int(values.get("save_every", 0) or 0) or int(values.get("steps_per_frame", 50) or 1)
            self.resume_offset = len(STORE.frame_files(session_id)) * save_every
        STORE.update(session_id, state="launching", endedAt=None)
        HUB.publish("state", {"sessionId": session_id, "state": "launching", "seed": s.get("seed")})
        threading.Thread(target=self._pump_stdout, args=(proc, session_id), daemon=True).start()
        threading.Thread(target=self._watch_frames, args=(session_id,), daemon=True).start()
        return session_id

    def stop(self, session_id: str):
        with self._lock:
            if self.proc is None or self.live_id != session_id:
                raise KeyError(session_id)
            self.stop_requested = True
            proc = self.proc
        STORE.update(session_id, state="stopping")
        HUB.publish("state", {"sessionId": session_id, "state": "stopping"})
        import signal

        def signal_group(sig):
            try:
                os.killpg(proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                pass

        signal_group(signal.SIGTERM)

        def enforcer():
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                signal_group(signal.SIGKILL)

        threading.Thread(target=enforcer, daemon=True).start()

    def enqueue(self, values: dict, fork_of: str | None, seed_locked: bool) -> dict:
        with self._lock:
            idle = self.proc is None
        if idle:
            # queue-when-idle would park a session forever; just run it
            sid, seed = self.start(values, fork_of, seed_locked)
            return {"sessionId": sid, "seed": seed, "startedImmediately": True}
        sid = STORE.mint_id(values.get("scenes", ""))
        with self._lock:
            replaced = self.queued is not None
            self.queued = {
                "id": sid, "slug": slugify(values.get("scenes", "")),
                "values": dict(values), "forkOf": fork_of, "seedLocked": seed_locked,
            }
        HUB.publish("queue", {"queued": {"id": sid, "slug": self.queued["slug"]}})
        return {"queued": sid, "replaced": replaced}

    def preempt(self, values: dict, fork_of: str | None, seed_locked: bool) -> dict:
        """Park the draft in the queue slot and stop the live render; the
        finalize path spawns the parked session. Atomic against finalize."""
        with self._lock:
            live = self.live_id
            if live is None:
                idle = True
            else:
                idle = False
                sid = STORE.mint_id(values.get("scenes", ""))
                self.queued = {
                    "id": sid, "slug": slugify(values.get("scenes", "")),
                    "values": dict(values), "forkOf": fork_of, "seedLocked": seed_locked,
                }
        if idle:
            sid, seed = self.start(values, fork_of, seed_locked)
            return {"sessionId": sid, "seed": seed}
        HUB.publish("queue", {"queued": {"id": self.queued["id"], "slug": self.queued["slug"]}})
        self.stop(live)
        return {"preempting": live, "queued": sid}

    def clear_queue(self):
        with self._lock:
            self.queued = None
        HUB.publish("queue", {"queued": None})

    # ── subprocess plumbing ────────────────────────────────────────────────

    def _pump_stdout(self, proc: subprocess.Popen, sid: str):
        self._fail_tail = deque(maxlen=25)
        try:
            self._pump_stdout_inner(proc, sid)
        finally:
            # finalize must run no matter what killed the pump — a stuck
            # manager wedges every future run
            try:
                proc.wait(timeout=600)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            self._finalize(sid, proc.returncode, list(self._fail_tail))

    def _pump_stdout_inner(self, proc: subprocess.Popen, sid: str):
        values = self.live_values or {}
        pre_steps = int(values.get("pre_animation_steps", 0) or 0)
        steps_per_scene = int(values.get("steps_per_scene", 100) or 1)
        steps_per_frame = int(values.get("steps_per_frame", 50) or 1)
        save_every = int(values.get("save_every", 0) or 0) or steps_per_frame
        interp = int(values.get("interpolation_steps", 0) or 0)
        n_scenes = scene_count(values.get("scenes", ""))
        scene_prompts_seen = 0
        last_progress_pub = 0.0
        fail_tail = self._fail_tail
        rendering_announced = False

        for line in iter(proc.stdout.readline, ""):
          try:
            text = ANSI_ESCAPE.sub("", line.split("\r")[-1].rstrip())
            if not text.strip():
                continue
            fail_tail.append(text)
            is_noise = bool(LOG_NOISE.search(text))

            m = TQDM_RE.search(text)
            if m and scene_prompts_seen == 0:
                # model-download progress bars also match TQDM_RE; real
                # training bars only appear after the first "Running prompt:"
                m = None
            if m:
                if not rendering_announced:
                    rendering_announced = True
                    STORE.update(sid, state="rendering")
                    HUB.publish("state", {"sessionId": sid, "state": "rendering", "seed": STORE.sessions[sid].get("seed")})
                bar_step, _bar_total = int(m.group(1)), int(m.group(2))
                rate = float(m.group(3))
                s_per_step = rate if m.group(4) == "s/it" else (1.0 / rate if rate else 0.0)
                step = self.resume_offset + max(0, self.scene) * steps_per_scene + bar_step
                with self._lock:
                    self.step = step
                    if s_per_step > 0:
                        self.samples += 1
                        self.s_per_step_ewma = (
                            s_per_step if self.samples == 1
                            else 0.1 * s_per_step + 0.9 * self.s_per_step_ewma
                        )
                now = time.time()
                if now - last_progress_pub >= 0.5:
                    last_progress_pub = now
                    sps = self.s_per_step_ewma
                    remaining = max(0, self.steps_total - step)
                    phase = "scene"
                    if step < pre_steps:
                        phase = "pre_animation"
                    elif self.scene > 0 and (step % steps_per_scene) < interp:
                        phase = "interpolation"
                    HUB.publish("progress", {
                        "sessionId": sid,
                        "step": step,
                        "stepsTotal": self.steps_total,
                        "scene": max(0, self.scene),
                        "sceneCount": n_scenes,
                        "phase": phase,
                        "sPerStep": round(sps, 2),
                        "etaSec": int(remaining * sps) if sps else 0,
                        "elapsedSec": int(time.time() - self.started_at),
                        "nextFrameInSec": int((save_every - (step % save_every)) * sps) if sps else 0,
                    })
                continue  # tqdm lines are not log lines

            if SCENE_RE.search(text):
                scene_prompts_seen += 1
                with self._lock:
                    self.scene = max(0, scene_prompts_seen - 1)
                if not rendering_announced:
                    rendering_announced = True
                    STORE.update(sid, state="rendering")
                    HUB.publish("state", {"sessionId": sid, "state": "rendering", "seed": STORE.sessions[sid].get("seed")})
                HUB.publish("log", {"sessionId": sid, "line": text, "kind": "scene"})
                continue
            if is_noise:
                continue
            kind = "info"
            if re.search(r"error|traceback|exception", text, re.IGNORECASE):
                kind = "error"
            elif re.search(r"warn", text, re.IGNORECASE):
                kind = "warn"
            if not rendering_announced and re.search(r"Loading CLIP|Loading AdaBins|Downloading", text):
                STORE.update(sid, state="loading_models")
                HUB.publish("state", {"sessionId": sid, "state": "loading_models", "seed": STORE.sessions[sid].get("seed")})
            HUB.publish("log", {"sessionId": sid, "line": text, "kind": kind})
          except Exception:
            # one bad line must never stop the pump: stdout has to keep
            # draining or the render blocks on a full pipe
            import traceback
            traceback.print_exc()

    def _finalize(self, sid: str, exit_code: int, fail_tail: list):
        with self._lock:
            stop_requested = self.stop_requested
            step = self.step
            sps = self.s_per_step_ewma
            elapsed = int(time.time() - self.started_at)
            self.proc = None
            self.live_id = None
            self.live_values = None
            queued = self.queued
            self.queued = None

        frames = len(STORE.frame_files(sid))
        if stop_requested:
            state = "stopped"
        elif exit_code == 0:
            state = "done"
        else:
            state = "failed"
        session = STORE.update(
            sid,
            state=state,
            endedAt=now_ms(),
            stepsDone=step,
            frames=frames,
            sPerStepAvg=round(sps, 2) if sps else None,
            elapsedSec=elapsed,
            exitCode=exit_code,
            failExcerpt=fail_tail[-2:] if state == "failed" else None,
        )
        pid_file = OUTPUTS_DIR / sid / "pid"
        if pid_file.exists():
            pid_file.unlink()
        if sps and step > 20 and state in ("done", "stopped"):
            CALIBRATION.record(session["config"], sps, sid)
        HUB.publish("state", {
            "sessionId": sid, "state": state, "exitCode": exit_code,
            "seed": session.get("seed"),
            "summary": {"steps": step, "frames": frames, "elapsedSec": elapsed,
                        "sPerStepAvg": session.get("sPerStepAvg")},
        })

        if queued is not None:
            HUB.publish("queue", {"queued": None})
            try:
                self.start(queued["values"], queued["forkOf"], queued["seedLocked"], session_id=queued["id"])
            except RuntimeError as e:  # pragma: no cover — race with a manual start
                print(f"[queue] could not start queued session: {e}", file=sys.stderr)

    def _watch_frames(self, sid: str):
        frames_dir = OUTPUTS_DIR / sid / "images_out" / sid
        seen: set[str] = {p.name for p in STORE.frame_files(sid)}
        while True:
            with self._lock:
                alive = self.live_id == sid and self.proc is not None
            if frames_dir.exists():
                for p in sorted(frames_dir.iterdir()):
                    if p.suffix != ".png" or p.name in seen:
                        continue
                    seen.add(p.name)
                    m = re.search(r"_(\d+)\.png$", p.name)
                    index = int(m.group(1)) if m else len(seen)
                    STORE.update(sid, frames=len(seen))
                    HUB.publish("frame", {
                        "sessionId": sid,
                        "index": index,
                        "step": self.step,
                        "url": f"/api/sessions/{sid}/frames/{index}",
                        "thumbUrl": f"/api/sessions/{sid}/thumbs/{index}",
                        "savedTotal": len(seen),
                    })
            if not alive:
                return
            time.sleep(0.5)

    def orphan_recovery(self):
        """Finalize sessions that were live when a previous server died."""
        for sid, s in list(STORE.sessions.items()):
            if s.get("imported"):
                continue
            pid_file = OUTPUTS_DIR / sid / "pid"
            if s.get("state") in ("launching", "loading_models", "rendering", "stopping") or pid_file.exists():
                pid = None
                if pid_file.exists():
                    try:
                        pid = int(pid_file.read_text().strip())
                    except ValueError:
                        pid = None
                alive = False
                if pid is not None:
                    try:
                        os.kill(pid, 0)
                        alive = True
                    except (ProcessLookupError, PermissionError):
                        alive = False
                if alive:
                    print(f"[recover] pid {pid} for {sid} still running; leaving it alone", file=sys.stderr)
                    continue
                frames = len(STORE.frame_files(sid))
                STORE.update(sid, state="stopped", endedAt=now_ms(), frames=frames)
                if pid_file.exists():
                    pid_file.unlink()
                print(f"[recover] finalized orphan session {sid} as stopped ({frames} frames)", file=sys.stderr)


MANAGER = RenderManager()


# ─────────────────────────────────────────────────────────────────────────────
# Encode manager
# ─────────────────────────────────────────────────────────────────────────────


class EncodeManager:
    def __init__(self):
        self._lock = threading.Lock()
        self.jobs: dict[str, dict] = {}  # jobId -> {proc, sessionId, ...}
        self._next = 1

    def start(self, session_id: str, fps: int | None, fmt: str, proxy: bool = False) -> str:
        if fmt not in ENCODE_FORMATS:
            raise ValueError(f"unknown format {fmt!r}")
        s = STORE.sessions.get(session_id)
        if s is None:
            raise KeyError(session_id)
        frames = STORE.frame_files(session_id)
        if not frames:
            raise ValueError("session has no frames")
        fps = int(fps or s.get("config", {}).get("frames_per_second") or 12)

        first = frames[0].name
        m = re.match(r"^(.+_)(\d+)\.png$", first)
        if not m:
            raise ValueError(f"cannot parse frame pattern from {first}")
        prefix, digits = m.group(1), len(m.group(2))
        pattern = str(frames[0].parent / f"{prefix}%0{digits}d.png")
        start_number = min(int(re.search(r"_(\d+)\.png$", p.name).group(1)) for p in frames)

        run_dir = STORE.run_dir(session_id)
        spec = ENCODE_FORMATS[fmt]
        out_name = f"{session_id}_{fps}fps{spec['ext']}"
        out_path = run_dir / out_name
        n = 1
        while out_path.exists():
            out_path = run_dir / f"{session_id}_{fps}fps({n}){spec['ext']}"
            n += 1

        cmd = [
            "ffmpeg", "-y", "-framerate", str(fps),
            "-start_number", str(start_number), "-i", pattern,
            *spec["args"],
            "-progress", "pipe:1", "-nostats", "-loglevel", "error",
            str(out_path),
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        with self._lock:
            job_id = f"enc-{self._next}"
            self._next += 1
            self.jobs[job_id] = {
                "proc": proc, "sessionId": session_id, "out": out_path,
                "framesTotal": len(frames), "cancelled": False,
            }
        threading.Thread(target=self._pump, args=(job_id,), daemon=True).start()
        HUB.publish("encode", {"jobId": job_id, "sessionId": session_id,
                               "framesDone": 0, "framesTotal": len(frames), "state": "running"})
        return job_id

    def cancel(self, job_id: str):
        with self._lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            job["cancelled"] = True
        job["proc"].terminate()

    def _pump(self, job_id: str):
        job = self.jobs[job_id]
        proc, sid = job["proc"], job["sessionId"]
        # drain stderr on its own thread so a chatty ffmpeg can't fill the
        # pipe and deadlock us while we block on stdout
        stderr_chunks: list[str] = []
        def drain():
            stderr_chunks.append(proc.stderr.read())
        drainer = threading.Thread(target=drain, daemon=True)
        drainer.start()
        frames_done = 0
        for line in iter(proc.stdout.readline, ""):
            if line.startswith("frame="):
                try:
                    frames_done = int(line.split("=", 1)[1].strip())
                except ValueError:
                    continue
                HUB.publish("encode", {"jobId": job_id, "sessionId": sid,
                                       "framesDone": frames_done, "framesTotal": job["framesTotal"],
                                       "state": "running"})
        proc.wait()
        drainer.join(timeout=5)
        stderr = stderr_chunks[0] if stderr_chunks else ""
        if job["cancelled"]:
            state = "cancelled"
            job["out"].unlink(missing_ok=True)
        elif proc.returncode == 0:
            state = "done"
        else:
            state = "failed"
            print(f"[encode] ffmpeg failed: {stderr[-400:]}", file=sys.stderr)
        out_url = None
        if state == "done":
            out_url = f"/api/sessions/{sid}/artifacts/{job['out'].name}"
            STORE.update(sid, artifacts=STORE._scan_artifacts(STORE.run_dir(sid)))
        HUB.publish("encode", {"jobId": job_id, "sessionId": sid,
                               "framesDone": frames_done, "framesTotal": job["framesTotal"],
                               "state": state, "outUrl": out_url})


ENCODER = EncodeManager()


# ─────────────────────────────────────────────────────────────────────────────
# Draft / presets / system
# ─────────────────────────────────────────────────────────────────────────────


def _fresh_draft_values() -> dict:
    """Schema defaults + the app's curated creative defaults on top."""
    values = schema_defaults()
    default_yaml = CONFIG_DIR / "default.yaml"
    if default_yaml.exists():
        curated = yaml.safe_load(default_yaml.read_text(encoding="utf-8")) or {}
        for k, v in curated.items():
            if k in values and v is not None and v != "???":
                values[k] = v
    return values


def read_draft() -> dict:
    if DRAFT_PATH.exists():
        data = yaml.safe_load(DRAFT_PATH.read_text(encoding="utf-8")) or {}
        if "values" in data:
            merged = _fresh_draft_values()
            merged.update(data["values"])
            return {"values": merged, "forkOf": data.get("forkOf"), "seedLocked": bool(data.get("seedLocked", False))}
    return {"values": _fresh_draft_values(), "forkOf": None, "seedLocked": False}


def write_draft(data: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write(DRAFT_PATH, yaml.dump({
        "values": data["values"], "forkOf": data.get("forkOf"), "seedLocked": bool(data.get("seedLocked", False)),
    }, default_flow_style=False, allow_unicode=True))


def list_presets() -> list:
    out = []
    if CONF_DIR.exists():
        for p in sorted(CONF_DIR.glob("*.yaml")):
            if p.name.startswith("_"):
                continue
            values = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            out.append({"name": p.stem, "values": values, "savedAt": int(p.stat().st_mtime * 1000)})
    return out


def system_health() -> dict:
    import torch
    if torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    studio = yaml.safe_load(STUDIO_PATH.read_text(encoding="utf-8")) if STUDIO_PATH.exists() else {}
    return {
        "device": device,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "firstBoot": not bool(studio.get("firstBootDone")),
        "clipCache": str(Path.home() / ".cache" / "clip"),
    }


# ─────────────────────────────────────────────────────────────────────────────
# HTTP layer
# ─────────────────────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # quiet the default per-request stderr lines, keep errors
    def log_message(self, fmt, *args):
        pass

    # ── plumbing ───────────────────────────────────────────────────────────

    def _json(self, status: int, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _no_content(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0) or 0)
        return self.rfile.read(length) if length else b""

    def _body_json(self) -> dict:
        return json.loads(self._read_body() or b"{}")

    def _send_file(self, path: Path, content_type: str | None = None, immutable=False):
        if not path.exists() or not path.is_file():
            self._json(404, {"error": "not found"})
            return
        ctype = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        size = path.stat().st_size
        range_header = self.headers.get("Range")
        if range_header:
            m = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if m and not m.group(1) and m.group(2):
                # suffix form: last N bytes
                start = max(0, size - int(m.group(2)))
                end = size - 1
            else:
                start = int(m.group(1)) if m and m.group(1) else 0
                end = int(m.group(2)) if m and m.group(2) else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        if immutable:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    # ── SSE ────────────────────────────────────────────────────────────────

    def _serve_events(self):
        last_id = int(self.headers.get("Last-Event-ID", 0) or 0)
        q = HUB.subscribe(last_id)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            last_beat = time.time()
            while True:
                if q:
                    eid, event, data = q.popleft()
                    self.wfile.write(f"id: {eid}\nevent: {event}\ndata: {data}\n\n".encode())
                    self.wfile.flush()
                else:
                    time.sleep(0.05)
                    if time.time() - last_beat > 15:
                        last_beat = time.time()
                        self.wfile.write(b": heartbeat\n\n")
                        self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            HUB.unsubscribe(q)

    # ── routing ────────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/events":
                self._serve_events()
            elif path == "/api/schema":
                self._json(200, build_schema())
            elif path == "/api/health":
                self._json(200, system_health())
            elif path == "/api/draft":
                self._json(200, read_draft())
            elif path == "/api/sessions":
                self._json(200, {"sessions": STORE.summaries()})
            elif path == "/api/queue":
                with MANAGER._lock:
                    queued = MANAGER.queued
                self._json(200, {"queued": {"id": queued["id"], "slug": queued["slug"]} if queued else None})
            elif path == "/api/presets":
                self._json(200, {"presets": list_presets()})
            elif path == "/api/calibration":
                self._json(200, {"buckets": CALIBRATION.buckets})
            elif path == "/api/uploads":
                # Serve a previously-uploaded file (init thumbs, mask rematerialization).
                # The server owns "what is an upload": only files directly inside
                # UPLOADS_DIR qualify; anything else — including bench-browsed init
                # images from tweak bases — is a 404 and the client degrades.
                qs = urllib.parse.parse_qs(parsed.query)
                target = Path(qs.get("path", [""])[0]).expanduser().resolve()
                if target.parent == UPLOADS_DIR.resolve() and target.is_file():
                    self._send_file(target, immutable=True)  # names never reused (dedupe on upload)
                else:
                    self._json(404, {"error": "not an upload"})
            elif path.startswith("/api/browse"):
                qs = urllib.parse.parse_qs(parsed.query)
                base = Path(qs.get("path", [str(Path.home())])[0]).expanduser()
                entries = []
                if base.is_dir():
                    for p in sorted(base.iterdir()):
                        if p.name.startswith("."):
                            continue
                        entries.append({"name": p.name, "path": str(p), "dir": p.is_dir()})
                self._json(200, {"path": str(base), "entries": entries})
            elif path.startswith("/api/sessions/"):
                self._get_session_subresource(path)
            elif path == "/" or path == "/index.html":
                self._send_file(STATIC_DIR / "index.html", "text/html")
            else:
                # static assets
                target = (STATIC_DIR / path.lstrip("/")).resolve()
                if STATIC_DIR.resolve() in target.parents and target.is_file():
                    self._send_file(target)
                else:
                    self._json(404, {"error": "not found"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # surface, don't die
            import traceback
            traceback.print_exc()
            try:
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

    def _get_session_subresource(self, path: str):
        parts = path.split("/")  # ['', 'api', 'sessions', '<id>', maybe more...]
        sid = urllib.parse.unquote(parts[3])
        s = STORE.sessions.get(sid)
        if s is None:
            self._json(404, {"error": f"unknown session {sid}"})
            return
        if len(parts) == 4:
            detail = dict(STORE.summary(s))
            detail["config"] = s.get("config", {})
            self._json(200, detail)
            return
        kind = parts[4]
        if kind == "frames":
            index = int(parts[5])
            frame = self._frame_path(sid, index)
            self._send_file(frame, "image/png", immutable=True) if frame else self._json(404, {"error": "no such frame"})
        elif kind == "thumbs":
            index = int(parts[5])
            frame = self._frame_path(sid, index)
            if frame is None:
                self._json(404, {"error": "no such frame"})
                return
            thumb_dir = STORE.run_dir(sid) / "thumbs"
            thumb = thumb_dir / (frame.stem + ".jpg")
            if not thumb.exists():
                from PIL import Image
                thumb_dir.mkdir(exist_ok=True)
                im = Image.open(frame)
                im.thumbnail((384, 384))
                im.convert("RGB").save(thumb, "JPEG", quality=80)
            self._send_file(thumb, "image/jpeg", immutable=True)
        elif kind == "artifacts":
            name = urllib.parse.unquote(parts[5])
            if "/" in name or ".." in name:
                self._json(400, {"error": "bad artifact name"})
                return
            self._send_file(STORE.run_dir(sid) / name)
        else:
            self._json(404, {"error": "not found"})

    def _frame_path(self, sid: str, index: int) -> Path | None:
        frames_dir = STORE.frames_dir(sid)
        for candidate in (f"{sid}_{index:04d}.png", f"{sid}_{index}.png"):
            p = frames_dir / candidate
            if p.exists():
                return p
        # imported sessions have arbitrary namespaces; fall back to sorted order
        files = STORE.frame_files(sid)
        if 1 <= index <= len(files):
            return files[index - 1]
        return None

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/draft":
                body = self._body_json()
                if "values" not in body:
                    self._json(400, {"error": "missing values"})
                    return
                try:
                    body["values"] = coerce_values(body["values"])
                except ValueError as e:
                    self._json(400, {"error": str(e)})
                    return
                write_draft(body)
                self._no_content()
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/preflight":
                self._json(200, preflight(self._body_json().get("values", {})))
            elif path == "/api/sessions":
                self._post_sessions()
            elif re.fullmatch(r"/api/sessions/[^/]+/stop", path):
                sid = urllib.parse.unquote(path.split("/")[3])
                MANAGER.stop(sid)
                self._json(202, {"stopping": sid})
            elif re.fullmatch(r"/api/sessions/[^/]+/resume", path):
                sid = urllib.parse.unquote(path.split("/")[3])
                self._json(201, {"sessionId": MANAGER.resume(sid)})
            elif re.fullmatch(r"/api/sessions/[^/]+/encode", path):
                sid = urllib.parse.unquote(path.split("/")[3])
                body = self._body_json()
                job = ENCODER.start(sid, body.get("fps"), body.get("format", "mp4"), bool(body.get("proxy")))
                self._json(201, {"jobId": job})
            elif path == "/api/presets":
                body = self._body_json()
                name = re.sub(r"[^a-zA-Z0-9_-]", "-", str(body.get("name", "")).strip())
                if not name:
                    self._json(400, {"error": "preset needs a name"})
                    return
                CONF_DIR.mkdir(parents=True, exist_ok=True)
                atomic_write(CONF_DIR / f"{name}.yaml",
                             "# @package _global_\n" + yaml.dump(body.get("values", {}), default_flow_style=False, allow_unicode=True))
                self._json(201, {"name": name})
            elif path == "/api/uploads":
                self._post_upload()
            elif path == "/api/system":
                body = self._body_json()
                studio = yaml.safe_load(STUDIO_PATH.read_text(encoding="utf-8")) if STUDIO_PATH.exists() else {}
                studio.update(body)
                studio["firstBootDone"] = True
                atomic_write(STUDIO_PATH, yaml.dump(studio))
                self._no_content()
            else:
                self._json(404, {"error": "not found"})
        except KeyError as e:
            self._json(404, {"error": f"unknown: {e}"})
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _post_sessions(self):
        body = self._body_json()
        mode = body.get("mode", "now")
        draft = read_draft()
        values, fork_of, seed_locked = draft["values"], draft.get("forkOf"), draft.get("seedLocked", False)
        check = preflight(values)
        if not check["ok"]:
            self._json(400, {"error": "preflight failed", "issues": check["issues"]})
            return
        if mode == "queue":
            result = MANAGER.enqueue(values, fork_of, seed_locked)
            self._json(201 if result.get("startedImmediately") else 202, result)
            return
        if mode == "preempt":
            result = MANAGER.preempt(values, fork_of, seed_locked)
            self._json(201 if "sessionId" in result else 202, result)
            return
        try:
            sid, seed = MANAGER.start(values, fork_of, seed_locked)
            self._json(201, {"sessionId": sid, "seed": seed})
        except RuntimeError:
            with MANAGER._lock:
                live = MANAGER.live_id
            self._json(409, {"error": "busy", "live": live})

    def _post_upload(self):
        ctype = self.headers.get("Content-Type", "")
        if not ctype.startswith("multipart/form-data"):
            self._json(400, {"error": "expected multipart/form-data"})
            return
        body = self._read_body()
        msg = BytesParser(policy=HTTP).parsebytes(
            b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body
        )
        for part in msg.iter_parts():
            filename = part.get_filename()
            if not filename:
                continue
            UPLOADS_DIR.mkdir(exist_ok=True)
            safe = re.sub(r"[^a-zA-Z0-9._-]", "-", filename)
            dest = UPLOADS_DIR / safe
            n = 1
            while dest.exists():
                dest = UPLOADS_DIR / f"{Path(safe).stem}-{n}{Path(safe).suffix}"
                n += 1
            dest.write_bytes(part.get_payload(decode=True))
            self._json(200, {"path": str(dest)})
            return
        self._json(400, {"error": "no file in upload"})

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/queue":
                MANAGER.clear_queue()
                self._no_content()
            elif re.fullmatch(r"/api/sessions/[^/]+", path):
                sid = urllib.parse.unquote(path.split("/")[3])
                with MANAGER._lock:
                    if MANAGER.live_id == sid:
                        self._json(409, {"error": "session is rendering; stop it first"})
                        return
                STORE.delete(sid)
                self._no_content()
            elif re.fullmatch(r"/api/encodes/[^/]+", path):
                ENCODER.cancel(path.split("/")[3])
                self._no_content()
            else:
                self._json(404, {"error": "not found"})
        except KeyError as e:
            self._json(404, {"error": f"unknown: {e}"})
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    for d in (STATIC_DIR, CONF_DIR, SESSIONS_CONF_DIR, OUTPUTS_DIR):
        d.mkdir(parents=True, exist_ok=True)
    # warm the schema (fails loud at boot if annotations are incomplete)
    build_schema()
    MANAGER.orphan_recovery()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"PYTTI STUDIO on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
