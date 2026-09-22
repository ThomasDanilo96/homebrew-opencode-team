#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?usage: patch-omo-isolation.sh <omo-dist-index.js>}"
SENTINEL="_BEST_TEAM_SANDBOX_OVERRIDE_V1"

count=$(rg -o "$SENTINEL" "$TARGET" 2>/dev/null | wc -l | tr -d ' ' || true)
if [ "$count" -eq 1 ]; then
  printf '%s\n' "ALREADY_PATCHED: $TARGET"
  exit 0
fi
[ "$count" -eq 0 ] || { printf 'REFUSED: sentinel count=%s\n' "$count" >&2; exit 1; }

"${OPENCODE_TEAM_PYTHON:?OPENCODE_TEAM_PYTHON is required}" - "$TARGET" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
anchor = 'var __require = typeof import.meta.require === "function" ? import.meta.require : __omoCreateRequire(import.meta.url);\n'
marker = '\n// _BEST_TEAM_SANDBOX_OVERRIDE_V1: preserve HOME fallback while isolating candidate state.\nconst _bestTeamSandboxRoot = process.env.BEST_TEAM_SANDBOX || "";\n'
legacy = 'const _goSandbox = _path.join(_os.homedir(), ".opencode-best-team");'
core_aware = 'const _goSandbox = process.env.SANDBOX || _path.join(_os.homedir(), ".opencode-best-team");'
canonical = 'const _goSandbox = _bestTeamSandboxRoot || _path.join(_os.homedir(), ".opencode-best-team");'
legacy_sites = text.count(legacy)
core_aware_sites = text.count(core_aware)
if text.count(anchor) != 1:
    raise SystemExit(f"REFUSED: anchor={text.count(anchor)} legacy_sites={legacy_sites} core_aware_sites={core_aware_sites}")
if (legacy_sites, core_aware_sites) not in ((4, 0), (0, 4)):
    raise SystemExit(f"REFUSED: anchor=1 legacy_sites={legacy_sites} core_aware_sites={core_aware_sites}")
text = text.replace(anchor, anchor + marker, 1).replace(legacy, canonical).replace(core_aware, canonical)
path.write_text(text)
PY

node --check "$TARGET"
[ "$(rg -o "$SENTINEL" "$TARGET" | wc -l | tr -d ' ')" = 1 ]
