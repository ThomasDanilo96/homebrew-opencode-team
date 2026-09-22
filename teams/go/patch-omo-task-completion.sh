#!/usr/bin/env bash
set -euo pipefail

OMO="${1:-${GO_OMO_PATCH_TARGET:-}}"
if [ -z "$OMO" ] && [ -n "${SANDBOX:-}" ]; then
  GO_DEPENDENCY_ROOT="${OPENCODE_TEAM_DEPENDENCY_ROOT:-$(cd "$SANDBOX/../dependencies" && pwd)}"
  OMO="$GO_DEPENDENCY_ROOT/go/node_modules/oh-my-openagent/dist/index.js"
fi
[ -f "$OMO" ] || { printf 'GO OMO target missing: %s\n' "$OMO" >&2; exit 1; }
"${OPENCODE_TEAM_PYTHON:?OPENCODE_TEAM_PYTHON is required}" "$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patch-worker-done-v2.py" "$OMO"
"${OPENCODE_TEAM_PYTHON:?OPENCODE_TEAM_PYTHON is required}" "$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patch-routing.py" "$OMO"
node --check "$OMO"
