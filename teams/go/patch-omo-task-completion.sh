#!/usr/bin/env bash
set -euo pipefail

OMO="${1:-${GO_OMO_PATCH_TARGET:-}}"
if [ -z "$OMO" ] && [ -n "${SANDBOX:-}" ]; then
  OMO="$(cd "$SANDBOX/../dependencies/go/node_modules/oh-my-openagent/dist" && pwd)/index.js"
fi
[ -f "$OMO" ] || { printf 'GO OMO target missing: %s\n' "$OMO" >&2; exit 1; }
python3 "$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patch-worker-done-v2.py" "$OMO"
python3 "$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patch-routing.py" "$OMO"
node --check "$OMO"
