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

PORT="${PYTTI_STUDIO_PORT:-7860}"
( sleep 2 && open "http://127.0.0.1:$PORT" ) &
exec .venv/bin/python app/server.py
