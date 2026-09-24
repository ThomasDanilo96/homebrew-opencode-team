#!/usr/bin/env bash
set -euo pipefail

workflow="${1:-.github/workflows/homebrew-install.yml}"
expected_version="$(tr -d '[:space:]' < VERSION)"

[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
rg -Fq 'expected_version="$(tr -d '\''[:space:]'\'' < VERSION)"' "$workflow"
rg -Fq 'test "$(opencode-team version)" = "OpenCode Team $expected_version"' "$workflow"
if rg -n '0\.1\.17|v0\.1\.17' "$workflow"; then
  echo "workflow contains a stale release version" >&2
  exit 1
fi
if rg -n 'shasum -a 256 .*oh-my-openagent.*=' "$workflow"; then
  echo "workflow contains a frozen OMO bundle hash" >&2
  exit 1
fi
rg -Fq 'teams/best/verify-omo.sh' "$workflow"
rg -Fq 'teams/go/verify-omo.sh' "$workflow"
rg -Fq 'release_state' "$workflow"
