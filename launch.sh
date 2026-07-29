#!/bin/zsh
# Launch the pytti-able UI (macOS). Run ./install.sh once first.
set -euo pipefail
cd "$(dirname "$0")"

# keep loopback traffic off any system/env proxy (gradio's own localhost
# self-check goes through proxy-honoring clients)
export no_proxy="127.0.0.1,localhost,::1${no_proxy:+,$no_proxy}"
export NO_PROXY="$no_proxy"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Not installed yet — run ./install.sh first." >&2
  exit 1
fi

exec .venv/bin/python app/ui.py
