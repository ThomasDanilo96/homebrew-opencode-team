#!/usr/bin/env bash
set -euo pipefail

OMO="${1:?usage: verify-omo.sh <omo-dist-index.js>}"

count() {
  rg -o "$1" "$OMO" | wc -l | tr -d ' '
}

[ -f "$OMO" ]
[ "$(count '_GO_NATIVE_UI_NO_ATTACH_PATCH_V1')" = 1 ]
[ "$(count '_GO_TASK_NATIVE_UI_NO_ATTACH_PATCH_V1')" = 1 ]
[ "$(count '_GO_TASK_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1')" = 1 ]
[ "$(count '_GO_CALL_OMO_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1')" = 1 ]
[ "$(count '_GO_CALL_OMO_FG_ONLY_V1')" = 1 ]
[ "$(count '_GO_BUILDER_TASK_ALLOW_V1')" = 1 ]
[ "$(count '_GO_WORKER_DONE_COMPLETION_PATCH_V2')" = 0 ]
[ "$(count 'opencode-go-team-v2-visible')" = 0 ]
[ "$(count 'opencode-best-team')" = 4 ]
[ "$(count '_BEST_TEAM_SANDBOX_OVERRIDE_V1')" = 1 ]
[ "$(count 'typeof cmdHook.timeout === "number"')" = 1 ]
node --check "$OMO"
