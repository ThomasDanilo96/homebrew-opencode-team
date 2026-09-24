#!/usr/bin/env bash
set -euo pipefail

workflow="${1:-.github/workflows/homebrew-install.yml}"
expected_version="$(tr -d '[:space:]' < VERSION)"

[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
grep -Fq 'expected_version="$(tr -d '\''[:space:]'\'' < VERSION)"' "$workflow"
grep -Fq 'test "$(opencode-team version)" = "OpenCode Team $expected_version"' "$workflow"
if grep -En '0\.1\.17|v0\.1\.17' "$workflow"; then
  echo "workflow contains a stale release version" >&2
  exit 1
fi
if grep -En 'shasum -a 256 .*oh-my-openagent.*=' "$workflow"; then
  echo "workflow contains a frozen OMO bundle hash" >&2
  exit 1
fi
grep -Fq 'teams/best/verify-omo.sh' "$workflow"
grep -Fq 'teams/go/verify-omo.sh' "$workflow"
grep -Fq 'release_state' "$workflow"
