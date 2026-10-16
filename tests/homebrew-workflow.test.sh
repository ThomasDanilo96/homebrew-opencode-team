#!/usr/bin/env bash
set -euo pipefail

workflow="${1:-.github/workflows/homebrew-install.yml}"
expected_version="$(tr -d '[:space:]' < VERSION)"

[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
grep -Fq 'expected_version="$(tr -d '\''[:space:]'\'' < VERSION)"' "$workflow"
grep -Fq 'test "$(opencode-team version)" = "OpenCode Team $expected_version"' "$workflow"
grep -Fq 'if [ "$team" = best ]; then launch_team=best-opencode; fi' "$workflow"
grep -Fq 'OPENCODE_TEAM_PACKAGE_ROOT="$package_root"' "$workflow"
grep -Fq '"$ROOT/bin/opencode-team" best' "${workflow%/*}/../../tests/setup-smoke.sh"
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
grep -Fq 'brew test ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'brew audit --strict --formula ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'opencode-team best-ecc-setup' "$workflow"
grep -Fq 'opencode models openai' "$workflow"
grep -Fq 'opencode-team deep-audit-setup' "$workflow"
test "$(grep -Fc 'opencode-team deep-audit-setup' "$workflow")" -ge 2
grep -Fq 'opencode-team deep-audit-doctor' "$workflow"
grep -Fq 'tests/deep-audit-sandbox.test.sh' "$workflow"
grep -Fq 'tests/deep-audit-scanner.test.mjs' "$workflow"
grep -Fq 'tests/deep-audit-runtime-smoke.sh' "$workflow"
grep -Fq 'for team in best best-ecc deep-audit go openai daily' "$workflow"
grep -Fq 'tag_status=$?' "$workflow"
grep -Fq '[ "$tag_status" -eq 2 ]' "$workflow"
if command -v actionlint >/dev/null 2>&1; then
  actionlint "$workflow"
fi
