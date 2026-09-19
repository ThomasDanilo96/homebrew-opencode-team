#!/usr/bin/env bash
set -euo pipefail

TEAM_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$TEAM_ROOT/../../shared/runtime-env/github-token.sh"

export BEST_TEAM_SANDBOX="${SANDBOX:?SANDBOX must be set}"
BEST_DEPENDENCY_ROOT="${OPENCODE_TEAM_DEPENDENCY_ROOT:-$(cd "$SANDBOX/../dependencies" && pwd)}"
export BEST_OMO_PATCH_TARGET="${BEST_OMO_PATCH_TARGET:-$BEST_DEPENDENCY_ROOT/best/node_modules/oh-my-openagent/dist/index.js}"
export OMO_DISABLE_POSTHOG=1 OMO_SEND_ANONYMOUS_TELEMETRY=0
