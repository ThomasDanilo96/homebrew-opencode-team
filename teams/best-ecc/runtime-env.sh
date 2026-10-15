#!/usr/bin/env bash
set -euo pipefail

TEAM_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$TEAM_ROOT/../../shared/runtime-env/github-token.sh"

export BEST_TEAM_SANDBOX="${SANDBOX:?SANDBOX must be set}"
export BEST_TEAM_OMO_HOME="$BEST_TEAM_SANDBOX"
BEST_DEPENDENCY_ROOT="${OPENCODE_TEAM_DEPENDENCY_ROOT:-$(cd "$SANDBOX/../dependencies" && pwd)}"
export BEST_OMO_PATCH_TARGET="$BEST_DEPENDENCY_ROOT/best/node_modules/oh-my-openagent/dist/index.js"
export BEST_ROUTER_PATH="$TEAM_ROOT/../best/router-classify.sh"
export BEST_ECC_MODE=1
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
export ECC_HOOK_PROFILE=minimal
export ECC_DISABLED_HOOKS=stop:check-console-log
export OMO_DISABLE_POSTHOG=1 OMO_SEND_ANONYMOUS_TELEMETRY=0
