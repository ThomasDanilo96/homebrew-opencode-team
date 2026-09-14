#!/usr/bin/env bash
set -euo pipefail

TEAM_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$TEAM_ROOT/../../shared/runtime-env/github-token.sh"

export BEST_TEAM_SANDBOX="${SANDBOX:?SANDBOX must be set}"
export BEST_OMO_PATCH_TARGET="${BEST_OMO_PATCH_TARGET:-$(cd "$SANDBOX/../dependencies/best/node_modules/oh-my-openagent/dist" && pwd)/index.js}"
export OMO_DISABLE_POSTHOG=1 OMO_SEND_ANONYMOUS_TELEMETRY=0
