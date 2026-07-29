"""
patch_gradio.py
---------------
Post-install patch for a known bug in gradio_client 1.3.0 (bundled with
gradio 4.44.1): its JSON-schema walker crashes when a schema value is a
bool instead of a dict (e.g. `"additionalProperties": true`).

app/ui.py also monkey-patches this at runtime, so this on-disk patch is
belt-and-braces for the Windows portable install.

All pytti-core patches that used to live here (breath mode, zero-padded
frames, save_every auto-sync, the Windows path fix) are now real features
of pytti-core v2 — nothing to patch.

Run once after pip-installing all packages:
    python patch_gradio.py
"""

import pathlib
import sys

_here = pathlib.Path(__file__).parent.parent

# Windows portable layout, else the local venv
_candidates = [
    _here / "python" / "Lib" / "site-packages",
    _here / ".venv" / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages",
]

GRADIO_PATCHES = [
    # Patch 1: get_type() guard — returns "unknown" instead of crashing on bool
    (
        'def get_type(schema: dict):\n    if "const" in schema:',
        'def get_type(schema: dict):\n    if not isinstance(schema, dict):\n        return "unknown"\n    if "const" in schema:',
    ),
    # Patch 2: _json_schema_to_python_type() guard — bool/None schema → "Any"
    (
        'def _json_schema_to_python_type(schema: Any, defs) -> str:\n    """Convert the json schema into a python type hint"""\n    if schema == {}:\n        return "Any"',
        'def _json_schema_to_python_type(schema: Any, defs) -> str:\n    """Convert the json schema into a python type hint"""\n    if isinstance(schema, bool) or schema is None:\n        return "Any"\n    if schema == {}:\n        return "Any"',
    ),
]


def apply_patches(target, patches, label):
    if not target.exists():
        print(f"  SKIP: {target} not found — is {label} installed?")
        return
    text = target.read_text(encoding="utf-8")
    changed = False
    for old, new in patches:
        if old in text:
            text = text.replace(old, new)
            changed = True
            print(f"  Applied: {old[:60].strip()!r}...")
        elif new in text:
            print(f"  Already patched: {old[:60].strip()!r}...")
        else:
            print(f"  NOT FOUND: {old[:60].strip()!r}...")
    if changed:
        target.write_text(text, encoding="utf-8")
        print(f"  {label} patch complete.")
    else:
        print(f"  {label} already up to date.")


if __name__ == "__main__":
    print("Patching gradio_client...")
    for site_packages in _candidates:
        target = site_packages / "gradio_client" / "utils.py"
        if target.exists():
            apply_patches(target, GRADIO_PATCHES, "gradio_client")
            break
    else:
        print("  SKIP: no site-packages with gradio_client found.")
