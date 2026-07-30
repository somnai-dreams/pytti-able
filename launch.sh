#!/bin/zsh
# Launch PYTTI STUDIO (macOS). Run ./install.sh once first.
set -euo pipefail
cd "$(dirname "$0")"

# keep loopback traffic off any system/env proxy
export no_proxy="127.0.0.1,localhost,::1${no_proxy:+,$no_proxy}"
export NO_PROXY="$no_proxy"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Not installed yet — run ./install.sh first." >&2
  exit 1
fi

# An editable pytti-core picks up new *code* live, but new *dependencies*
# in its pyproject don't reach this venv on their own (schedulefree,
# open_clip, ... have all been added mid-development). Resync at launch —
# a sub-second no-op when nothing changed.
core_repo="$(.venv/bin/python - <<'PY'
import pathlib
import pytti

p = pathlib.Path(pytti.__file__).resolve()
if ".venv" not in p.parts:  # editable install: <repo>/src/pytti/__init__.py
    print(p.parents[2])
PY
)"
if [[ -n "$core_repo" ]]; then
  if ! command -v uv >/dev/null; then
    echo "uv is required to sync the editable pytti-core — brew install uv" >&2
    exit 1
  fi
  echo "Syncing editable pytti-core deps from $core_repo ..."
  uv pip install -q --python .venv/bin/python -e "$core_repo"
fi

PORT="${PYTTI_STUDIO_PORT:-7860}"
( sleep 2 && open "http://127.0.0.1:$PORT" ) &
exec .venv/bin/python app/server.py
