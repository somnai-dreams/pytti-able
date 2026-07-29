#!/bin/zsh
# pytti-able installer for macOS (Apple Silicon or Intel).
# Creates a local .venv and installs pytti-core + the UI dependencies.
#
# pytti-core source resolution:
#   1. $PYTTI_CORE_SOURCE if set (a pip requirement string)
#   2. a sibling ../pytti-core checkout (editable install — dev setup)
#   3. the published git repo (v2 branch)
set -euo pipefail
cd "$(dirname "$0")"

PYTTI_CORE_GIT="git+https://github.com/pxl-pshr/pytti-core.git@v2"

if ! command -v uv >/dev/null; then
  echo "uv is required — install it with:  brew install uv" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "note: ffmpeg not found; video encoding needs it (brew install ffmpeg)"
fi

if [[ -n "${PYTTI_CORE_SOURCE:-}" ]]; then
  core_source="$PYTTI_CORE_SOURCE"
elif [[ -d "../pytti-core/src/pytti" ]]; then
  core_source="-e ../pytti-core"
  echo "Using local pytti-core checkout: ../pytti-core"
else
  core_source="$PYTTI_CORE_GIT"
fi

echo "Creating .venv (python 3.10)..."
uv venv --python 3.10 .venv

echo "Installing pytti-core + UI dependencies..."
uv pip install --python .venv/bin/python ${=core_source} pyyaml

echo
echo "Done. Start the UI with:  ./launch.sh"
