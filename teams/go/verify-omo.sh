#!/usr/bin/env bash
set -euo pipefail

OMO="${1:?usage: verify-omo.sh <omo-dist-index.js>}"
PACKAGE_JSON="$(cd "$(dirname "$OMO")/.." && pwd)/package.json"

count() {
  rg -o "$1" "$OMO" | wc -l | tr -d ' '
}

[ -f "$OMO" ]
[ "$(node -p "require('$PACKAGE_JSON').version")" = "4.19.4" ]
[ "$(count '_GO_WORKER_DONE_COMPLETION_PATCH_V2')" = 1 ]
[ "$(count '_GO_NATIVE_UI_NO_ATTACH_PATCH_V1')" = 1 ]
[ "$(count '_GO_TASK_NATIVE_UI_NO_ATTACH_PATCH_V1')" = 1 ]
[ "$(count '_GO_TASK_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1')" = 1 ]
[ "$(count '_GO_CALL_OMO_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1')" = 1 ]
[ "$(count '_GO_CALL_OMO_FG_ONLY_V1')" = 1 ]
[ "$(count '_GO_BUILDER_TASK_ALLOW_V1')" = 1 ]
[ "$(count '_GO_FOREGROUND_WORKER_DONE_PATCH_V1')" = 0 ]
[ "$(count 'process.env.SANDBOX')" -ge 1 ]
[ "$(count 'atomic transition hold')" -ge 1 ]
[ "$(count 'FAIL-CLOSED')" -ge 1 ]
node --check "$OMO"
